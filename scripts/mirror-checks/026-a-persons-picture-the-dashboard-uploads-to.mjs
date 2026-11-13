import { compare, lastDefinition, need, problems, read, SCHEMA } from './lib.mjs';

// 26. A person's picture. The dashboard uploads to, downloads from and deletes `<id>/avatar` in the
// avatars bucket; manage-people's Remove Access deletes the same object; storage-init.mjs creates
// the bucket with its types and limit; and 0213's CHECK and is_own_avatar_object() name the object.
// A name only one side uses is a picture nobody can read or one Remove Access leaves behind; a type
// or a limit only one side holds is a picker that offers what the bucket refuses.
export default function check() {
  const ui = read('frontend/src/utils/picture.js');
  const fn = read('supabase/functions/manage-people/people.ts');
  const init = read('scripts/storage-init.mjs');
  const policies = read('supabase/storage-policies.sql');
  const uiBucket = need(ui, /^export const PICTURE_BUCKET = '([^']+)'$/m, 'PICTURE_BUCKET in frontend/src/utils/picture.js');
  const fnBucket = need(fn, /^export const PICTURE_BUCKET = "([^"]+)";$/m, 'PICTURE_BUCKET in manage-people/people.ts');
  const uiPath = need(ui, /^export const picturePath = \(userId\) => `\$\{userId\}(\/[^`]+)`$/m, 'picturePath() in frontend/src/utils/picture.js');
  const fnPath = need(fn, /^export const picturePath = \(userId: string\) => `\$\{userId\}(\/[^`]+)`;$/m, 'picturePath() in manage-people/people.ts');
  const uiTypes = need(ui, /^export const PICTURE_TYPES = \[([^\]]+)\]$/m, 'PICTURE_TYPES in frontend/src/utils/picture.js');
  const uiLimit = need(ui, /^export const PICTURE_STORED_MAX_BYTES = (\d+)$/m, 'PICTURE_STORED_MAX_BYTES in frontend/src/utils/picture.js');
  const initTypes = need(init, /^const AVATAR_MIME_TYPES = \[([^\]]+)\];$/m, 'AVATAR_MIME_TYPES in scripts/storage-init.mjs');
  const initLimit = need(init, /^const AVATAR_SIZE_LIMIT = (\d+);$/m, 'AVATAR_SIZE_LIMIT in scripts/storage-init.mjs');
  const initBucket = need(init, /id: '([^']+)',\s*public: false,\s*file_size_limit: AVATAR_SIZE_LIMIT,\s*allowed_mime_types: AVATAR_MIME_TYPES,/, "the bucket storage-init.mjs gives AVATAR_SIZE_LIMIT");
  const owner = lastDefinition('CREATE OR REPLACE FUNCTION public.is_own_avatar_object(', '$$;', 'is_own_avatar_object() in the applied chain');
  const ownerPath = owner && need(owner.body, /\(SELECT auth\.uid\(\)\)::text \|\| '(\/[^']+)'/, `the object is_own_avatar_object() admits (${owner.file})`);
  const check = need(SCHEMA, /CONSTRAINT person_profiles_avatar_path_is_the_owner_s CHECK \(\(\(avatar_path IS NULL\) OR \(avatar_path = \(\(user_id\)::text \|\| '(\/[^']+)'::text\)\)\)\)/, 'person_profiles_avatar_path_is_the_owner_s in the applied chain');
  const list = (m) => [...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]).sort().join(',');

  if (uiBucket && fnBucket) compare('picture', 'bucket the dashboard and manage-people name', uiBucket[1], fnBucket[1]);
  if (uiBucket && initBucket) compare('picture', 'bucket the dashboard names and storage-init.mjs creates', uiBucket[1], initBucket[1]);
  if (uiBucket && !new RegExp(`bucket_id = '${uiBucket[1].replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')}' AND public\\.is_own_avatar_object\\(`).test(policies)) {
    problems.push(`picture: no policy in supabase/storage-policies.sql admits the owner to the ${uiBucket[1]} bucket`);
  }
  if (uiPath && fnPath) compare('picture', 'object name the dashboard and manage-people use', uiPath[1], fnPath[1]);
  if (uiPath && ownerPath) compare('picture', `object name the dashboard uses and ${owner.file}'s is_own_avatar_object() admits`, uiPath[1], ownerPath[1]);
  if (uiPath && check) compare('picture', 'object name the dashboard uses and avatar_path\'s CHECK allows', uiPath[1], check[1]);
  if (uiTypes && initTypes) compare('picture', 'types the picker takes and the bucket admits', list(uiTypes), list(initTypes));
  if (uiLimit && initLimit) compare('picture', 'largest picture the page uploads and the bucket admits', uiLimit[1], initLimit[1]);
}
