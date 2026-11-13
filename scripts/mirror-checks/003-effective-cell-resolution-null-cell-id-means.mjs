import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 3. Effective cell resolution. NULL cell_id means inherit, so the COALESCE precedence is the rule:
// device first, gateway second.
export default function check() {
  const js = read('frontend/src/utils/cellResolution.js');
  const view = lastDefinition(
    'CREATE OR REPLACE VIEW public.device_locations',
    ';',
    'public.device_locations'
  );

  if (view) {
    const body = view.body;

    const sqlCoalesce = need(body, /COALESCE\((\w)\.cell_id,\s*(\w)\.cell_id\)/, 'COALESCE precedence in device_locations');
    if (sqlCoalesce) {
      compare('cellResolution', 'COALESCE precedence', 'device,gateway',
        `${sqlCoalesce[1] === 'd' ? 'device' : 'gateway'},${sqlCoalesce[2] === 'g' ? 'gateway' : 'device'}`);
    }

    // The three arms that resolve to no cell must do so on both sides: site-wide by assertion,
    // shadow and simulated because they are lanes rather than places. The JS pattern tolerates the
    // arms as one disjunction but requires each term.
    const flat = body.replace(/\s+/g, ' ');
    const nullArms = [
      ['site_wide', /WHEN \(d\.location_scope = 'site_wide'::text\) THEN NULL::uuid/.test(flat),
        /scope === SCOPE_SITE_WIDE[^?]*\? null :/.test(js)],
      ['shadow', /WHEN COALESCE\(g\.is_shadow, false\) THEN NULL::uuid/.test(flat),
        /\(\s*shadow \|\|/.test(js)],
      ['simulated', /WHEN COALESCE\(g\.is_simulated, false\) THEN NULL::uuid/.test(flat),
        /\|\| simulated \|\|/.test(js)]
    ];
    for (const [arm, sqlOk, jsOk] of nullArms) {
      if (!sqlOk || !jsOk) {
        problems.push(`cellResolution: the ${arm} branch must resolve to no cell on both sides (SQL ${sqlOk ? 'ok' : 'MISSING'}, JS ${jsOk ? 'ok' : 'MISSING'})`);
      } else {
        ok.push(`cellResolution: ${arm} resolves to no cell on both sides`);
      }
    }

    // Precedence: a shadow gateway is necessarily simulated, so testing simulated first makes the
    // shadow lane unreachable. Both sides must ask about shadow first.
    const sqlShadowFirst = flat.indexOf("THEN 'shadow'::text") < flat.indexOf("THEN 'simulated'::text");
    const jsShadowFirst = js.indexOf('if (shadow) source = SOURCE_SHADOW') < js.indexOf('source = SOURCE_SIMULATED');
    if (!sqlShadowFirst || !jsShadowFirst) {
      problems.push(`cellResolution: shadow must be tested before simulated on both sides (SQL ${sqlShadowFirst ? 'ok' : 'WRONG ORDER'}, JS ${jsShadowFirst ? 'ok' : 'WRONG ORDER'})`);
    } else {
      ok.push('cellResolution: shadow resolves ahead of simulated on both sides');
    }

    // The seven location_source labels are a closed set the UI switches on. `THEN` and `ELSE`,
    // because 'unassigned' is the CASE's fall-through. The alternation is spelled out so adding a
    // lane is a deliberate edit here too.
    const sqlSources = [...new Set([...body.matchAll(/(?:THEN|ELSE) '(site_wide|area_wide|explicit|inherited|unassigned|simulated|shadow)'::text/g)].map((m) => m[1]))].sort();
    const jsSources = [...new Set([...js.matchAll(/export const SOURCE_[A-Z_]+ = '([a-z_]+)'/g)].map((m) => m[1]))].sort();
    compare('cellResolution', 'location_source labels', jsSources.join(','), sqlSources.join(','));
  }
}
