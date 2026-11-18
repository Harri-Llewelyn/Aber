import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 460. The i3X documents name every local standard namespace the address space serves. A metric whose
// semantic id is minted here, MTConnect's, ISO 22400's or VDA 5050's, is typed in a local namespace
// of its own (_LOCAL_STANDARD_NAMESPACES in i3x/address_space.py). A client reads the list of
// namespaces from GET /namespaces and the two documents that describe it, and one the documents
// leave out is one a reader meets with no word on where it came from.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems460 = [];
  const table = read('i3x/address_space.py').match(/_LOCAL_STANDARD_NAMESPACES = \{([^}]*)\}/)?.[1] ?? '';
  const namespaces = [...table.matchAll(/"(https:\/\/aber\.local\/semantics\/[^"]+)":/g)].map((m) => m[1]);
  if (namespaces.length < 3) {
    fail('460: found fewer than three local standard namespaces in i3x/address_space.py -- the table changed shape, so this check is no longer checking anything');
    return;
  }

  for (const file of ['i3x/README.md', 'docs/i3x-openapi.yaml']) {
    const text = read(file);
    for (const uri of namespaces) {
      if (!text.includes(`\`${uri}\``)) problems460.push(`${file} does not name ${uri}`);
    }
  }

  if (problems460.length) {
    fail('the i3X documents leave out a local standard namespace the address space serves:\n' + problems460.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the i3X README and API reference name each of the ${namespaces.length} local standard namespaces the address space serves (${namespaces.map((u) => u.slice('https://aber.local/semantics/'.length)).join(', ')})`);
  }
}
