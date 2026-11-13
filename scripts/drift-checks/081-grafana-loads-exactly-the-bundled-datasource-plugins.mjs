import { allFiles, CHART_VALUES, chartPins, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 81. Grafana loads exactly the bundled datasource plugins Aber uses. Grafana starts a process for
// every bundled backend datasource plugin it loads, so grafana.ini disables each one no provisioned
// datasource needs. grafana/README.md lists the image's bundled plugins under the tag they were read
// from: every one is provisioned or disabled, no provisioned type and no type a dashboard or rule
// queries is disabled, and a chart pin other than that tag fails until the list is read again. The
// chart overrides the line only as the ini's list less grafana.enablePlugins, which is empty by default.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const README = 'grafana/README.md';
  const INI = 'grafana/grafana.ini';
  const DATASOURCES = 'grafana/provisioning/datasources/datasources.template.yml';
  const problems81 = [];

  let section = '';
  let disabledLine = null;
  for (const line of read(INI).split(/\r?\n/)) {
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) { section = header[1]; continue; }
    const kv = line.match(/^disable_plugins\s*=\s*(.*?)\s*$/);
    if (kv && section === 'plugins') disabledLine = kv[1];
  }
  const disabled = new Set((disabledLine ?? '').split(/[\s,]+/).filter(Boolean));

  const readme = read(README);
  const tagged = readme.match(/bundled backend datasource plugins of `grafana\/grafana:([^`]+)`/);
  const rows = [];
  if (tagged) {
    const after = readme.slice(tagged.index).split('\n').slice(1);
    const start = after.findIndex((l) => l.startsWith('|'));
    for (const line of start < 0 ? [] : after.slice(start)) {
      if (!line.startsWith('|')) break;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const id = cells[0]?.match(/^`([^`]+)`$/)?.[1];
      if (!id) continue;
      rows.push({ id, aliases: [...(cells[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]), status: cells[2] ?? '' });
    }
  }
  const pinned = chartPins.get('grafana/grafana');

  // Datasource type -> plugin id, through the aliases the image's plugin.json files declare.
  const pluginOf = (type) => rows.find((r) => r.id === type || r.aliases.includes(type))?.id ?? type;
  const provisioned = new Map(read(DATASOURCES).split(/^ {2}- /m).slice(1)
    .map((entry) => [entry.match(/^ {4}uid: (\S+)$/m)?.[1], entry.match(/^ {4}type: (\S+)$/m)?.[1]])
    .filter(([uid, type]) => uid && type));
  const queried = new Set(provisioned.values());
  for (const f of allFiles.filter((f) => f.startsWith('grafana/provisioning/dashboards/') && f.endsWith('.json'))) {
    for (const [, body] of read(f).matchAll(/"datasource":\s*\{([^{}]*)\}/g)) {
      const type = body.match(/"type":\s*"([^"]+)"/)?.[1];
      if (type) queried.add(type);
    }
  }
  for (const [, uid] of read('grafana/provisioning/alerting/alert-rules.yaml').matchAll(/datasourceUid:\s*(\S+)/g)) {
    if (provisioned.has(uid)) queried.add(provisioned.get(uid));
  }

  if (!disabledLine) problems81.push(`${INI}: no [plugins] disable_plugins line`);
  if (!tagged || !rows.length) problems81.push(`${README}: no table of the bundled backend datasource plugins of a grafana/grafana tag`);
  if (provisioned.size < 3) problems81.push(`${DATASOURCES}: read ${provisioned.size} datasource(s); the parse has stopped matching the file`);
  if (tagged && pinned !== tagged[1]) {
    problems81.push(`the chart pins grafana/grafana:${pinned}, but ${README} lists the plugins of ${tagged[1]}; read the list `
      + `from the new image (the command is in ${README}, "Bundled plugins") and mark each new one`);
  }
  const provisionedPlugins = new Set([...provisioned.values()].map(pluginOf));
  for (const row of rows) {
    const used = provisionedPlugins.has(row.id);
    if (used && disabled.has(row.id)) problems81.push(`${row.id} is provisioned and disabled`);
    if (!used && !disabled.has(row.id)) problems81.push(`${row.id} is bundled, provisioned by nothing and not in disable_plugins`);
    const want = used ? 'Provisioned' : 'Disabled';
    if (row.status !== want) problems81.push(`${README} marks ${row.id} "${row.status}", want "${want}"`);
  }
  for (const id of disabled) {
    if (!rows.some((r) => r.id === id)) problems81.push(`disable_plugins names ${id}, which ${README} does not list as bundled`);
  }
  for (const type of queried) {
    if (disabled.has(pluginOf(type)) || disabled.has(type)) problems81.push(`a datasource, dashboard or alert rule uses type ${type}, which is disabled`);
  }
  // The one override allowed: grafana.enablePlugins, empty by default, taken out of the ini's own list.
  const template = read('deploy/helm/aber/templates/obs/grafana.yaml');
  const derived = /\{\{- if \$keepPlugins \}\}\n(?: *#.*\n)* *- name: GF_PLUGINS_DISABLE_PLUGINS\n *value: \{\{ \$disablePlugins \| quote \}\}\n *\{\{- end \}\}/;
  if (template.split('GF_PLUGINS_DISABLE_PLUGINS').length - 1 !== (derived.test(template) ? 1 : 0)) {
    problems81.push('templates/obs/grafana.yaml sets GF_PLUGINS_DISABLE_PLUGINS other than as grafana.ini\'s list less grafana.enablePlugins');
  }
  if (derived.test(template) && !/regexFind "\(\?m\)\^disable_plugins [^"]*" \$ini/.test(template)) {
    problems81.push('templates/obs/grafana.yaml no longer reads the list it overrides from grafana.ini');
  }
  if (!/^grafana:\n(?: .*\n|\n)*? {2}enablePlugins: \[\]$/m.test(CHART_VALUES)) {
    problems81.push('values.yaml: grafana.enablePlugins is not empty by default, so the chart overrides grafana.ini');
  }

  if (problems81.length) {
    fail('Grafana would load a plugin nothing uses, or refuse one Aber uses:\n' + problems81.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`grafana.ini disables ${disabled.size} of grafana/grafana:${pinned}'s ${rows.length} bundled backend datasource plugins `
      + `and none of the ${provisionedPlugins.size} Aber provisions`);
  }
}
