#!/usr/bin/env node
/**
 * Create the 3D-model storage bucket, idempotently.
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
 * The RLS policies that govern the objects *inside* the bucket are a different matter and DO live
 * in migration 0035 -- they are policies on storage.objects, which exists from the stub onward.
 *
 * IDEMPOTENT, because compose re-runs this on every `up`. It asks whether the bucket exists before
 * deciding to create it, rather than creating it and treating the failure as success: storage-api
 * answers a duplicate create with **400** "The resource already exists", not the 409 the status
 * code alone would suggest, so a conflict and a genuinely malformed request are indistinguishable
 * by status. The settings are then reconciled either way, so changing the size limit in .env takes
 * effect on the next boot rather than needing the bucket dropped.
 */

const STORAGE_URL = process.env.STORAGE_URL || 'http://supabase-storage:5000';
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || '';
const BUCKET = process.env.STORAGE_BUCKET || 'asset-3d-models';
const FILE_SIZE_LIMIT = Number.parseInt(process.env.STORAGE_FILE_SIZE_LIMIT || '52428800', 10);

/**
 * The formats the UI accepts, declared on the bucket as well as in the browser.
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
 * allow-list in migration 0035's CHECK is what actually constrains what can be referenced.
 */
const ALLOWED_MIME_TYPES = [
  'model/gltf-binary',
  'model/gltf+json',
  'model/obj',
  'model/stl',
  'model/mesh',
  'text/plain',
  'application/octet-stream',
];

const headers = {
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  apikey: SERVICE_ROLE_KEY,
  'Content-Type': 'application/json',
};

const settings = {
  public: true,
  file_size_limit: FILE_SIZE_LIMIT,
  allowed_mime_types: ALLOWED_MIME_TYPES,
};

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

async function main() {
  if (!SERVICE_ROLE_KEY) {
    console.error('[storage-init] SERVICE_ROLE_KEY is empty; cannot authenticate to Storage.');
    process.exit(1);
  }

  const existing = await fetch(`${STORAGE_URL}/bucket/${encodeURIComponent(BUCKET)}`, { headers });
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
      body: JSON.stringify({ id: BUCKET, name: BUCKET, ...settings }),
    });
    if (!create.ok) {
      const body = await readBody(create);
      console.error(`[storage-init] failed to create bucket (${create.status}):`, body.message || body);
      process.exit(1);
    }
    console.log(`[storage-init] created bucket "${BUCKET}" (public, limit ${FILE_SIZE_LIMIT} bytes)`);
  } else if (existing.ok) {
    console.log(`[storage-init] bucket "${BUCKET}" already exists; reconciling settings`);
  } else {
    console.error(
      `[storage-init] cannot reach Storage (${existing.status}):`,
      existingBody?.message || existingBody,
    );
    process.exit(1);
  }

  // Runs on the create path too. A bucket created by an older revision of this script -- or by
  // hand in Studio -- is brought up to the current settings rather than left as it was found.
  const update = await fetch(`${STORAGE_URL}/bucket/${encodeURIComponent(BUCKET)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(settings),
  });

  if (!update.ok) {
    const body = await readBody(update);
    console.error(`[storage-init] failed to update bucket (${update.status}):`, body.message || body);
    process.exit(1);
  }

  console.log(`[storage-init] bucket "${BUCKET}" is public and ready.`);
}

main().catch((err) => {
  console.error('[storage-init]', err instanceof Error ? err.message : err);
  process.exit(1);
});
