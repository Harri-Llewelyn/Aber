import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 27. The Directory's exposure map names the same ingress routes in the seed and the chart.
//
// `0002` reads each row's exposure from `directory_exposure` by route name, and the chart's
// `aber.directoryExposure` decides it for a fixed list of names. A name on one side only leaves
// that row at the seed's default whatever the chart publishes, with nothing failing; each must
// also be a route `aber.ingressRoutes` builds.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SEED = 'supabase/migrations/0002_seed_data.sql';
  const HELPERS = 'deploy/helm/aber/templates/_helpers.tpl';
  const seed = read(SEED);
  const tpl = read(HELPERS);

  const seedAt = seed.indexOf('\\if :{?directory_exposure}');
  const block = seedAt === -1 ? '' : seed.slice(seedAt, seed.indexOf(') AS s(id, route, exposure)', seedAt));
  const seeded = new Set([...block.matchAll(/'f1111111-[0-9a-f-]+'::uuid,\s*'([a-z0-9-]+)',/g)].map((m) => m[1]));

  const mapAt = tpl.indexOf('define "aber.directoryExposure"');
  const mapBody = mapAt === -1 ? '' : tpl.slice(mapAt, tpl.indexOf('toJson $out', mapAt));
  const rangeLine = mapBody.match(/range list ((?:"[a-z0-9-]+"\s*)+)/);
  const mapped = new Set(rangeLine ? [...rangeLine[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]) : []);

  const routesAt = tpl.indexOf('define "aber.ingressRoutes"');
  const routesBody = routesAt === -1 ? '' : tpl.slice(routesAt, tpl.indexOf('toYaml $routes', routesAt));
  const routes = new Set([...routesBody.matchAll(/\(dict "name" "([a-z0-9-]+)"/g)].map((m) => m[1]));

  if (!seeded.size || !mapped.size || !routes.size) {
    fail(
      `check 27 read ${seeded.size} route(s) from ${SEED}, ${mapped.size} from aber.directoryExposure ` +
        `and ${routes.size} from aber.ingressRoutes; the extraction no longer matches one of them`
    );
  } else {
    const offences = [
      ...[...seeded].filter((r) => !mapped.has(r)).map((r) => `${r} keys a Directory row in ${SEED} and is not in aber.directoryExposure`),
      ...[...mapped].filter((r) => !seeded.has(r)).map((r) => `${r} is in aber.directoryExposure and keys no Directory row`),
      ...[...mapped].filter((r) => !routes.has(r)).map((r) => `${r} is not a route aber.ingressRoutes builds`),
    ];
    if (offences.length) {
      fail('the Directory exposure map disagrees with itself:\n' + offences.map((o) => `        ${o}`).join('\n'));
    } else {
      pass(`the Directory exposure map names the same ${mapped.size} ingress route(s) in the seed and the chart`);
    }
  }
}
