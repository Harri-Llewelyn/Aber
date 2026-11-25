import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { compare, need, problems, read, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 160. What a nameplate must hold to claim its template, in two places. The exporter decides the claim
// (_shared/aas/shell.ts) and the Nameplate dialog says what is still missing for it
// (frontend/src/utils/nameplate.js). Both take the top of the template from idta_template_elements, so what
// can differ is the four address elements, which only the specification's text names, and the two
// templates' ids. A difference is a dialog that says a nameplate is complete and an export that claims
// nothing, or the other way round. The four, and the id, are Contact Information's as 0324 seeds it.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  const api = read('frontend/src/api.js');
  const dialog = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/nameplate.js')).href);

  const exported = need(shell, /export const MANDATORY_ADDRESS_ELEMENTS = \[([^\]]*)\]/, 'MANDATORY_ADDRESS_ELEMENTS in shell.ts');
  const four = [...(exported?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]);
  if (exported) compare('nameplate', 'the address elements a nameplate must hold', dialog.MANDATORY_ADDRESS_ELEMENTS, four);
  for (const element of four) {
    if (!SCHEMA.includes(`('ContactInformation.${element}', 'ContactInformation', `)) {
      problems.push(`nameplate: no migration seeds Contact Information's ${element}, which a nameplate must hold`);
    }
  }

  const nameplate = need(shell, /export const NAMEPLATE_TEMPLATE_ID =\s*"([^"]+)"/, 'NAMEPLATE_TEMPLATE_ID in shell.ts');
  const nameplateInApi = need(api, /const NAMEPLATE_TEMPLATE_ID = '([^']+)'/, 'NAMEPLATE_TEMPLATE_ID in api.js');
  if (nameplate && nameplateInApi) compare('nameplate', 'the Nameplate template the dashboard reads and the exporter claims', nameplateInApi[1], nameplate[1]);

  const contact = need(shell, /export const CONTACT_INFORMATION_TEMPLATE_ID =\s*"([^"]+)"/, 'CONTACT_INFORMATION_TEMPLATE_ID in shell.ts');
  const contactInApi = need(api, /const CONTACT_INFORMATION_TEMPLATE_ID = '([^']+)'/, 'CONTACT_INFORMATION_TEMPLATE_ID in api.js');
  const seeded = need(SCHEMA, /^SELECT '([^']+)', 'Contact Information', 'IDTA 02002', '[^']+',$/m, 'the seeded Contact Information template');
  if (contact && contactInApi) compare('nameplate', 'the Contact Information template the dashboard and the exporter read', contactInApi[1], contact[1]);
  if (contact && seeded) compare('nameplate', 'the Contact Information template the exporter reads and the one seeded', contact[1], seeded[1]);
}
