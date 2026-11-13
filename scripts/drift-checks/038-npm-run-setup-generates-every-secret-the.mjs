import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 38. `npm run setup` generates every secret the chart needs.
//
// A `secrets.*` key setup leaves out installs as the chart's default, "". For a required one that
// is a stack that fails after the install: an empty i3X broker password left mosquitto in
// Init:Error on every site set up this way. Each key setup does not write is named here with why it
// may stay empty, so a new key fails until someone decides.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const OPTIONAL = {
    existingSecret: 'names an external Secret, the alternative to these values',
    grafanaAdminUser: 'a username, with a default',
    mqttDynsecAdminUser: 'a username, with a default',
    mqttI3xUser: 'a username, with a default',
    mqttIngestionUser: 'a username, with a default',
    mqttMonitorUser: 'a username, with a default',
    mqttValidatorUser: 'a username, with a default',
    mqttPlaybackCredentials: 'empty is valid: the worker refuses a job for a gateway it holds no credential for',
    archiveS3SecretAccessKey: 'deprecated and read by nothing: the cold archive key is set on the Cold Storage page',
    smtpPassword: 'only for supabaseAuth.smtp, which setup does not configure',
    giteaMachinePassword: 'deprecated and read by nothing: the machine account is a bot with a token the forge mints',
  };
  const values = read('deploy/helm/aber/values.yaml');
  const block = /^secrets:\n([\s\S]*?)^\S/m.exec(values)?.[1] ?? '';
  const declared = [...block.matchAll(/^ {2}([A-Za-z0-9]+):/gm)].map((m) => m[1]);

  const setup = read('scripts/setup.mjs');
  const minted = /^const secrets = \{\n([\s\S]*?)^\};/m.exec(setup)?.[1] ?? '';
  const written = new Set([
    ...[...minted.matchAll(/^ {2}([A-Za-z0-9]+)[:,]/gm)].map((m) => m[1]),
    ...[...setup.matchAll(/\bsecrets\.([A-Za-z0-9]+)\s*=/g)].map((m) => m[1]),
    ...[...(/deliberatelyEmpty = \[([^\]]*)\]/.exec(setup)?.[1] ?? '').matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]),
  ]);

  if (!declared.length || !written.size) {
    fail('check 38 found no secrets block in values.yaml or no `const secrets = {` in scripts/setup.mjs, so it compares nothing');
  } else {
    const missing = declared.filter((k) => !written.has(k) && !(k in OPTIONAL));
    const stale = Object.keys(OPTIONAL).filter((k) => written.has(k) || !declared.includes(k));
    for (const k of missing) {
      fail(`values.yaml declares secrets.${k}, and npm run setup does not write it. Generate it in setup.mjs's ` +
        '`secrets`, or, if an empty value really is valid, add it to check 38\'s OPTIONAL with the reason.');
    }
    for (const k of stale) fail(`check 38's OPTIONAL names secrets.${k}, which setup writes or values.yaml no longer declares: remove it`);
    if (!missing.length && !stale.length) {
      pass(`npm run setup writes ${declared.length - Object.keys(OPTIONAL).length} of values.yaml's ${declared.length} secrets; the other ${Object.keys(OPTIONAL).length} may stay empty`);
    }
  }
}
