import { compare, need, problems, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 10. The Directory's device address, TypeScript to Python. Both project a device's address from the
// same columns, and its `device_id` is the id it publishes under, chosen by `identity_source`. A
// column one side stops reading, or a source only one side handles, gives that side the issued id
// for a device publishing another: the same device at two addresses.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const ts = read('supabase/functions/fplus-directory/index.ts');
  const py = read('ingestion/directory_publish.py');
  const columns = (block) => [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
  const tsColumns = need(ts, /const DEVICE_COLUMNS =([^;]+);/, 'DEVICE_COLUMNS in fplus-directory/index.ts');
  const pyColumns = need(py, /^_DEVICE_COLUMNS = \(([^)]*\([^)]*\)[^)]*)\)/m, '_DEVICE_COLUMNS in directory_publish.py');
  if (tsColumns && pyColumns) {
    compare('directoryDeviceColumns', 'the device columns read', columns(pyColumns[1]), columns(tsColumns[1]));
  }
  const tsRule = need(ts, /function publishedDeviceId\([\s\S]*?\n\}/, 'publishedDeviceId() in fplus-directory/index.ts');
  const pyRule = need(py, /^def _published_device_id\([\s\S]*?\n(?=\S)/m, '_published_device_id() in directory_publish.py');
  if (tsRule && pyRule) {
    // Each side's (identity_source, column) pairs, in its order, and the fallback after them.
    const tsPairs = [...tsRule[0].matchAll(/source === "(\w+)"\s*\?\s*(null|row\.(\w+))/g)]
      .map((m) => `${m[1]}->${m[3] ?? 'issued'}`);
    const pyPairs = [...pyRule[0].matchAll(/source == "(\w+)":\s*published = (None|row\.get\("(\w+)"\))/g)]
      .map((m) => `${m[1]}->${m[3] ?? 'issued'}`);
    const tsElse = need(tsRule[0], /:\s*row\.(\w+);/, 'the fallback column of publishedDeviceId()');
    const pyElse = need(pyRule[0], /else:\s*published = row\.get\("(\w+)"\)/, 'the fallback column of _published_device_id()');
    if (tsPairs.length === 0 || pyPairs.length === 0) {
      problems.push('directoryPublishedId: found no identity_source branch -- the function\'s shape changed, so this check is no longer checking anything');
    } else if (tsElse && pyElse) {
      compare('directoryPublishedId', 'the id each identity_source publishes under',
        [...pyPairs, `else->${pyElse[1]}`].join(', '), [...tsPairs, `else->${tsElse[1]}`].join(', '));
    }
  }
}
