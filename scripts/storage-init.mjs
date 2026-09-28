#!/usr/bin/env node
// Creates the platform's storage buckets through the Storage REST API, idempotently, on every upgrade
// (the storage-init hook Job). Not a SQL migration: storage.buckets is owned by storage-api, whose
// own migrations run after ours, and the image's stub of it cannot mark a bucket public. The RLS
// policies on the objects are supabase/storage-policies.sql; the two must agree on bucket names, and
// check-docs-drift holds them and the README's table together. Reasoning: supabase/README.md,
// "Storage buckets and why they differ".

const STORAGE_URL = process.env.STORAGE_URL || 'http://supabase-storage:5000';
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || '';
// The 3D-model bucket's own limit, not STORAGE_FILE_SIZE_LIMIT: that is storage-api's global
// ceiling, which must be at least the largest bucket (broker-captures, 100 MiB).
const FILE_SIZE_LIMIT = Number.parseInt(
  process.env.STORAGE_MODEL_FILE_SIZE_LIMIT || '52428800',
  10,
);

// Declared on the bucket as the control; the browser's accept filter is a convenience. octet-stream
// and text/plain are deliberate: browsers report .obj and .stl inconsistently, and the migration's
// extension CHECK is what constrains what a shell can reference.
const MODEL_MIME_TYPES = [
  'model/gltf-binary',
  'model/gltf+json',
  'model/obj',
  'model/stl',
  'model/mesh',
  'text/plain',
  'application/octet-stream',
];

// JSON and nothing else; text/plain and octet-stream for the same browser reason. The uploader
// checks that the payload is a capture before it is sent.
const CAPTURE_MIME_TYPES = [
  'application/json',
  'text/json',
  'text/plain',
  'application/octet-stream',
];

// 100 MiB, above the 50 MiB cap capture_jobs puts on a recording: a capture that completed must not
// then fail to upload. Anything raising the job cap raises this too.
const CAPTURE_FILE_SIZE_LIMIT = Number.parseInt(
  process.env.CAPTURE_FILE_SIZE_LIMIT || '104857600',
  10,
);

// SVG exactly, with no fallback: every browser reports it. Active content, so the bucket is private
// and the dashboard renders a plan through <img>.
const AREA_PLAN_MIME_TYPES = ['image/svg+xml'];

// 5 MiB. A drawing larger than that is a CAD export, not a plan.
const AREA_PLAN_SIZE_LIMIT = 5242880;

// 256 MiB, above the largest bundle the row caps in bundle.ts admit; the row caps are the real limit.
const ASSET_EXPORT_SIZE_LIMIT = 268435456;

// .aasx is a ZIP and browsers disagree about what to call one; the function sets the type itself.
const ASSET_EXPORT_MIME_TYPES = [
  'application/octet-stream',
  'application/zip',
  'application/asset-administration-shell-package+xml',
];

// A list in code, not parameters: whether a bucket is public must be readable here, beside its reason.
const BUCKETS = [
  {
    id: process.env.STORAGE_BUCKET || 'asset-3d-models',
    // Public read by design: an exported AAS File URL must dereference for a viewer holding no session,
    // and a signed URL would expire.
    public: true,
    file_size_limit: FILE_SIZE_LIMIT,
    allowed_mime_types: MODEL_MIME_TYPES,
    why: '3D models referenced by exported AAS shells',
  },
  {
    id: process.env.CAPTURE_BUCKET || 'broker-captures',
    // Private, and the setting the whole bucket turns on: storage-api serves public objects without
    // consulting storage.objects RLS at all. Re-asserted on every boot by the reconcile below.
    public: false,
    file_size_limit: CAPTURE_FILE_SIZE_LIMIT,
    allowed_mime_types: CAPTURE_MIME_TYPES,
    why: 'broker captures for playback, under <sparkplug_id>/ of the gateway they play back as',
  },
  {
    // Its own bucket, not the cold archive's: a bundle is a copy derived from rows still in the
    // database, a cold object is the only copy of its history. Private: it carries a device's whole
    // history.
    id: 'asset-exports',
    public: false,
    file_size_limit: ASSET_EXPORT_SIZE_LIMIT,
    allowed_mime_types: ASSET_EXPORT_MIME_TYPES,
    why: 'AAS export bundles, under assets/<device>/, referenced by asset_exports.object_key',
  },
  {
    // Fixed names, not environment variables: storage-policies.sql and the frontend name these buckets
    // too, and a name changeable in one place is a bucket with no policies.
    id: 'area-plans',
    public: false,
    file_size_limit: AREA_PLAN_SIZE_LIMIT,
    allowed_mime_types: AREA_PLAN_MIME_TYPES,
    why: 'area plans drawn by the Site Map, under <area_id>/, referenced by areas.plan_path',
  },
];

// Buckets that were renamed. Each old bucket's objects move to the new one under the same keys,
// then the old bucket is deleted: storage-api deletes only an empty bucket, and nothing else in
// the stack removes one. Once the old bucket is gone this does nothing.
const RENAMED_BUCKETS = [
  { from: 'floor-plans', to: 'area-plans' },
];

// storage-api's list page size; a longer folder is read a page at a time.
const LIST_PAGE = 100;

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

/** True when the bucket exists, false when storage-api says it does not; throws on anything else. */
async function bucketExists(id) {
  const existing = await fetch(`${STORAGE_URL}/bucket/${encodeURIComponent(id)}`, { headers });
  if (existing.ok) return true;
  const body = await readBody(existing);
  // storage-api v1.11 answers both "does not exist" and "already exists" with HTTP 400, so only the
  // payload distinguishes them. Verified against the running service.
  if (/not found/i.test(String(body?.message ?? ''))) return false;
  throw new Error(`cannot reach Storage for "${id}" (${existing.status}): ${body?.message || body}`);
}

async function ensureBucket(spec) {
  const { id, why, ...settings } = spec;

  if (!(await bucketExists(id))) {
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
  } else {
    console.log(`[storage-init] bucket "${id}" already exists; reconciling settings`);
  }

  // Runs on the create path too, so a bucket made by an older revision or by hand in Studio is
  // brought to the current settings; for the private buckets this is what re-asserts public: false.
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

/** Every object key in a bucket. storage-api lists one folder level at a time; a folder has no id. */
async function listKeys(bucket, prefix = '') {
  const keys = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const res = await fetch(`${STORAGE_URL}/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prefix, limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) {
      const body = await readBody(res);
      throw new Error(`failed to list "${bucket}/${prefix}" (${res.status}): ${body.message || body}`);
    }
    const entries = await res.json();
    for (const entry of entries) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id == null) keys.push(...(await listKeys(bucket, key)));
      else keys.push(key);
    }
    if (entries.length < LIST_PAGE) return keys;
  }
}

/**
 * Moves a renamed bucket's objects into its new bucket and deletes the old one. The keys are kept,
 * so a row that names an object by key still finds it. A missing old bucket is the settled state.
 * A failed move throws before the delete, so the old bucket and whatever it still holds survive
 * for the next run.
 */
async function retireBucket({ from, to }) {
  if (!(await bucketExists(from))) {
    console.log(`[storage-init] bucket "${from}" is gone; nothing to move into "${to}".`);
    return;
  }

  const keys = await listKeys(from);
  for (const key of keys) {
    const res = await fetch(`${STORAGE_URL}/object/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bucketId: from, sourceKey: key, destinationBucket: to, destinationKey: key }),
    });
    if (!res.ok) {
      const body = await readBody(res);
      throw new Error(`failed to move "${from}/${key}" to "${to}" (${res.status}): ${body.message || body}`);
    }
  }

  const del = await fetch(`${STORAGE_URL}/bucket/${encodeURIComponent(from)}`, { method: 'DELETE', headers });
  if (!del.ok) {
    const body = await readBody(del);
    throw new Error(`moved ${keys.length} object(s) but could not delete bucket "${from}" (${del.status}): ${body.message || body}`);
  }
  console.log(`[storage-init] moved ${keys.length} object(s) from "${from}" to "${to}" and deleted "${from}".`);
}

async function main() {
  if (!SERVICE_ROLE_KEY) {
    console.error('[storage-init] SERVICE_ROLE_KEY is empty; cannot authenticate to Storage.');
    process.exit(1);
  }

  // Sequential, so a failure names the bucket rather than surfacing as one rejected promise among
  // several with the others in an unknown state.
  for (const spec of BUCKETS) {
    await ensureBucket(spec);
  }

  // After the creates, so every destination exists before anything moves into it.
  for (const rename of RENAMED_BUCKETS) {
    await retireBucket(rename);
  }

  console.log(`[storage-init] ${BUCKETS.length} bucket(s) ready.`);
}

main().catch((err) => {
  console.error('[storage-init]', err instanceof Error ? err.message : err);
  process.exit(1);
});
