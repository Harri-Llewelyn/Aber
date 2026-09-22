#!/usr/bin/env node
/**
 * Create the platform's storage buckets, idempotently.
 *
 * WHY THIS IS NOT A SQL MIGRATION. `storage.buckets` is owned by storage-api, which runs its own
 * migrations against that schema when it boots. The supabase/postgres image ships only a stub of
 * it -- `id`, `name`, `owner`, timestamps, and none of `public`, `file_size_limit` or
 * `allowed_mime_types`. supabase-db-init replays our migrations long BEFORE storage-api starts, so
 * on a fresh stack a migration inserting into storage.buckets would hit the stub: it could create
 * the row but could not mark it public, and the bucket would come up private on first boot and
 * only correct itself on the second. Creating it through the Storage REST API instead runs after
 * storage-api is healthy and is indifferent to which columns this version's schema has.
 *
 * The RLS policies that govern the objects *inside* each bucket are a different matter and live in
 * supabase/storage-policies.sql -- they are policies on storage.objects, which exists from the stub
 * onward. THE TWO FILES MUST AGREE ON THE BUCKET NAMES: a bucket created here with no policies is
 * invisible to every browser-facing role (RLS denies by default), and a policy naming a bucket that
 * was never created is dead text. Neither errors.
 *
 * IDEMPOTENT, because the storage-init hook Job runs on every upgrade. It asks whether each bucket exists before
 * deciding to create it, rather than creating it and treating the failure as success: storage-api
 * answers a duplicate create with **400** "The resource already exists", not the 409 the status
 * code alone would suggest, so a conflict and a genuinely malformed request are indistinguishable
 * by status. The settings are then reconciled either way, so changing the size limit in .env takes
 * effect on the next boot rather than needing the bucket dropped.
 *
 * THE BUCKETS ARE A LIST IN CODE, NOT PARAMETERS. They differ in the setting that matters most --
 * whether they are public -- and expressing that as an environment variable would leave "is this
 * bucket public?" answerable only by reading a .env file. Each entry states it next to its reason.
 */

const STORAGE_URL = process.env.STORAGE_URL || 'http://supabase-storage:5000';
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || '';
/**
 * The 3D-model bucket's OWN limit, which is NOT `STORAGE_FILE_SIZE_LIMIT`.
 *
 * That variable is storage-api's GLOBAL CEILING for every bucket, and storage-api refuses to create
 * a bucket whose limit exceeds it -- so the ceiling has to be at least the largest bucket
 * (`broker-captures`, 100 MiB). Reading it here would mean raising the ceiling for one bucket
 * silently raised this one too. Two jobs, two variables: the ceiling is the largest bucket, and
 * this is what a model may be.
 */
const FILE_SIZE_LIMIT = Number.parseInt(
  process.env.STORAGE_MODEL_FILE_SIZE_LIMIT || '52428800',
  10,
);

/**
 * The formats the 3D uploader accepts, declared on the bucket as well as in the browser.
 *
 * The client-side accept filter is a convenience; this is the control. A bucket that took any
 * MIME type would let an authenticated caller store arbitrary content under a path the exporter
 * then publishes as a public URL inside an AAS shell.
 *
 * `model/*` is the registered tree for 3D formats (RFC 9245 registers model/gltf+json and
 * model/gltf-binary), but browsers are inconsistent about what they put in `File.type` for these:
 * .obj and .stl frequently arrive as `application/octet-stream` or an empty string, because the
 * OS has no mapping for them. Rejecting those would make .obj/.stl uploads fail on some machines
 * and not others, so the octet-stream fallback is deliberate rather than lax -- the extension
 * allow-list in the 3D model migration's CHECK is what actually constrains what can be referenced.
 */
const MODEL_MIME_TYPES = [
  'model/gltf-binary',
  'model/gltf+json',
  'model/obj',
  'model/stl',
  'model/mesh',
  'text/plain',
  'application/octet-stream',
];

/**
 * A broker capture is JSON and nothing else.
 *
 * `text/plain` and `application/octet-stream` are here for the same reason they are in the list
 * above and NOT because anything else is allowed: a browser handing back a `.json` picked from
 * disk reports its type inconsistently across platforms. The uploader checks that the payload IS
 * a capture -- that it carries `aber_capture_version` and a `messages` array -- before it is sent,
 * so this list is the coarse outer bound rather than the check.
 */
const CAPTURE_MIME_TYPES = [
  'application/json',
  'text/json',
  'text/plain',
  'application/octet-stream',
];

/**
 * 100 MiB for a broker capture.
 *
 * Sized from the traffic rather than picked: the fleet's measured rate is 0.95 msg/s and a message
 * is a few hundred bytes of JSON, so an hour of a real shift is single-digit megabytes and a full
 * working day fits. What this refuses is a capture taken at the ingestion ceiling -- 240 msg/s --
 * running for far longer than anybody needs, which would otherwise quietly fill the volume.
 *
 * ---------------------------------------------------------------------------------------------
 * RAISED FROM 25 MiB BY 0055, AND THE TWO NUMBERS HAVE TO BE READ TOGETHER.
 *
 * `capture_jobs` caps a recording at 50 MiB, and that cap is useless unless the bucket can hold
 * what it allows. The failure of getting this backwards is the worst possible ordering: a capture
 * that reached its size cap would terminate SUCCESSFULLY, be uploaded, and be refused -- and by
 * then the recording exists only in a buffer that is about to be freed. The three job caps are
 * mutually consistent so that the MESSAGE cap binds first (100,000 messages at a few hundred bytes
 * is roughly 40 MB); this leaves headroom above the size cap rather than sitting under it.
 *
 * Anything raising the job cap in `capture_jobs_caps_are_bounded` has to raise this too.
 */
const CAPTURE_FILE_SIZE_LIMIT = Number.parseInt(
  process.env.CAPTURE_FILE_SIZE_LIMIT || '104857600',
  10,
);

/**
 * A floor plan is SVG and nothing else. Exact, with no octet-stream fallback: every browser
 * reports `image/svg+xml` for a .svg picked from disk, and the dashboard sets the type itself.
 * SVG is active content, so the bucket is private and the dashboard renders a plan through an
 * <img>, where scripts, foreign objects and external references cannot run.
 */
const FLOOR_PLAN_MIME_TYPES = ['image/svg+xml'];

/** 5 MiB for a floor plan. A drawing larger than that is a CAD export, not a plan. */
const FLOOR_PLAN_SIZE_LIMIT = 5242880;

/**
 * An AAS export bundle (`.aasx`), which is a ZIP of XML and CSV parts.
 *
 * 256 MiB against a bundle capped at 200,000 telemetry rows and 20,000 thread rows
 * (supabase/functions/_shared/aas/bundle.ts): comfortably above the largest bundle those caps
 * admit, and low enough that it is not a route to filling the volume. The row caps are the real
 * limit; this is the one that stops a bug from becoming a disk.
 */
const ASSET_EXPORT_SIZE_LIMIT = 268435456;

/**
 * `.aasx` is a ZIP by construction and browsers disagree about what to call one, so both the
 * generic and the ZIP types are admitted. The function sets the type itself
 * (EXPORT_CONTENT_TYPE) and uploads as service_role; this list is what keeps a hand-uploaded
 * file from arriving as something a viewer would execute.
 */
const ASSET_EXPORT_MIME_TYPES = [
  'application/octet-stream',
  'application/zip',
  'application/asset-administration-shell-package+xml',
];

const BUCKETS = [
  {
    id: process.env.STORAGE_BUCKET || 'asset-3d-models',
    // PUBLIC-READ BY DESIGN. An exported AAS `File` element's URL has to be dereferenceable by a
    // viewer holding no Factory+ session, and a signed URL would expire and break every shell
    // already handed out.
    public: true,
    file_size_limit: FILE_SIZE_LIMIT,
    allowed_mime_types: MODEL_MIME_TYPES,
    why: '3D models referenced by exported AAS shells',
  },
  {
    id: process.env.CAPTURE_BUCKET || 'broker-captures',
    // PRIVATE, AND THIS IS THE SETTING THE WHOLE BUCKET TURNS ON. A capture is a recording of the
    // plant's Sparkplug traffic: every edge node and device id that spoke during the window, every
    // metric name they publish, and the values. `public: true` here would put all of that at a
    // guessable, unauthenticated URL -- and because storage-api serves public objects without
    // consulting storage.objects RLS at all, the role split in supabase/storage-policies.sql would
    // simply stop applying to reads. The reconcile step below re-asserts this on every boot, so a
    // bucket flipped public by hand in Studio is corrected rather than left.
    //
    // Note that a capture filed under one gateway's prefix can name OTHER gateways -- it records
    // whatever was on the wire. That is not a leak across the prefix rule: the roles that can read
    // this bucket (Administrator, Shopfloor_Manager, Auditor) can already see the whole fleet in
    // the directory. It is the reason the bucket is not readable by anyone below them.
    public: false,
    file_size_limit: CAPTURE_FILE_SIZE_LIMIT,
    allowed_mime_types: CAPTURE_MIME_TYPES,
    why: 'broker captures for playback, under <sparkplug_id>/ of the gateway they play back as',
  },
  {
    // AAS export bundles. Fixed, not an environment variable, for the reason floor-plans gives
    // below: the name is also in storage-policies.sql and in the function that writes here.
    //
    // ITS OWN BUCKET, NOT THE COLD ARCHIVE'S. They are not the same kind of object: a bundle is a
    // COPY somebody asked for, derived from rows still in the database, so it belongs on local
    // storage where the browser can sign a URL for it. A cold telemetry object is the only
    // remaining copy of that history and goes to a remote endpoint the browser never touches
    // (`0132`). One retention decision cannot serve both.
    id: 'asset-exports',
    // Private. The bundle carries a device's whole history -- every reading, every thread entry
    // -- so a guessable unauthenticated URL would hand over the plant's record of one machine.
    public: false,
    file_size_limit: ASSET_EXPORT_SIZE_LIMIT,
    allowed_mime_types: ASSET_EXPORT_MIME_TYPES,
    why: 'AAS export bundles, under assets/<device>/, referenced by asset_exports.object_key',
  },
  {
    // Fixed, not an environment variable: supabase/storage-policies.sql and frontend/src/api.js
    // name this bucket too, and a name that can be changed in one place is a bucket with no
    // policies. Private: a plan is a drawing of the plant, and SVG is active content.
    id: 'floor-plans',
    public: false,
    file_size_limit: FLOOR_PLAN_SIZE_LIMIT,
    allowed_mime_types: FLOOR_PLAN_MIME_TYPES,
    why: 'floor plans drawn by the Site Map, under <area_id>/, referenced by areas.plan_path',
  },
];

const headers = {
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  apikey: SERVICE_ROLE_KEY,
  'Content-Type': 'application/json',
};

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

/** Create the bucket if absent, then reconcile its settings either way. */
async function ensureBucket(spec) {
  const { id, why, ...settings } = spec;

  const existing = await fetch(`${STORAGE_URL}/bucket/${encodeURIComponent(id)}`, { headers });
  const existingBody = existing.ok ? null : await readBody(existing);

  // storage-api v1.11 answers BOTH "this bucket does not exist" and "this bucket already exists"
  // with HTTP 400, so the status alone cannot distinguish a missing bucket from a real failure --
  // only the payload can. Verified against the running service rather than assumed; the obvious
  // reading (404 for absent, 409 for duplicate) is wrong for both.
  const isMissing = !existing.ok && /not found/i.test(String(existingBody?.message ?? ''));

  if (isMissing) {
    const create = await fetch(`${STORAGE_URL}/bucket`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id, name: id, ...settings }),
    });
    if (!create.ok) {
      const body = await readBody(create);
      throw new Error(`failed to create bucket "${id}" (${create.status}): ${body.message || body}`);
    }
    console.log(`[storage-init] created bucket "${id}" -- ${why}`);
  } else if (existing.ok) {
    console.log(`[storage-init] bucket "${id}" already exists; reconciling settings`);
  } else {
    throw new Error(
      `cannot reach Storage for "${id}" (${existing.status}): ${existingBody?.message || existingBody}`,
    );
  }

  // Runs on the create path too. A bucket created by an older revision of this script -- or by
  // hand in Studio -- is brought up to the current settings rather than left as it was found.
  // For the private buckets this is what re-asserts `public: false` on every boot.
  const update = await fetch(`${STORAGE_URL}/bucket/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(settings),
  });

  if (!update.ok) {
    const body = await readBody(update);
    throw new Error(`failed to update bucket "${id}" (${update.status}): ${body.message || body}`);
  }

  console.log(
    `[storage-init] bucket "${id}" is ${settings.public ? 'PUBLIC' : 'private'}, `
    + `limit ${settings.file_size_limit} bytes.`,
  );
}

async function main() {
  if (!SERVICE_ROLE_KEY) {
    console.error('[storage-init] SERVICE_ROLE_KEY is empty; cannot authenticate to Storage.');
    process.exit(1);
  }

  // SEQUENTIAL, not Promise.all. storage-api is single-tenant here and a failure part-way through
  // should name the bucket that failed rather than surfacing as one rejected promise among several
  // with the others in an unknown state.
  for (const spec of BUCKETS) {
    await ensureBucket(spec);
  }

  console.log(`[storage-init] ${BUCKETS.length} bucket(s) ready.`);
}

main().catch((err) => {
  console.error('[storage-init]', err instanceof Error ? err.message : err);
  process.exit(1);
});
