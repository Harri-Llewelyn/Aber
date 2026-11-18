#!/usr/bin/env node
/**
 * Write the dashboard's list of built-in alerts from the file that provisions them.
 *
 *   node scripts/generate-built-in-alerts.mjs            # write frontend/src/utils/builtInAlerts.generated.json
 *   node scripts/generate-built-in-alerts.mjs --check    # exit 1 if the committed copy is stale (CI)
 *
 * The Automations page's Built-in tab lists every alert Aber raises about itself. The source is
 * `grafana/provisioning/alerting/alert-rules.yaml`, read here and bundled with the dashboard: the
 * dashboard never asks Grafana, so it needs no token and keeps working when Grafana leaves the
 * default install. The copy is committed, like the chart's mirrors, because the frontend image builds
 * from `./frontend` and cannot see the file. `--check` fails when the copy is stale.
 *
 * What a row says comes from the rule: its uid, title, group, `for`, labels and summary template; its
 * query or queries, as written; and its threshold, read off the condition node. What the rule FIRES ON,
 * in words, is the comment above it, which the file's header makes the convention ("Title: what it
 * evaluates"): the first sentence is the row's, the rest the drawer's. A rule with no such comment is
 * refused, so a new rule cannot reach the list without its words.
 *
 * `yaml` is the frontend's dependency, so this runs where `npm ci` has run in `frontend/`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'grafana/provisioning/alerting/alert-rules.yaml';
const TARGET = 'frontend/src/utils/builtInAlerts.generated.json';

const SEVERITIES = ['critical', 'warning', 'info'];
const SUBJECTS = ['device', 'gateway', 'platform', 'service_identity'];
const UID = /^[A-Za-z0-9_-]{1,40}$/;
const LANGUAGES = { supabase: 'sql', prometheus: 'promql' };

const fail = (message) => {
  console.error(`generate-built-in-alerts: ${message}`);
  process.exit(1);
};

/** A comment's lines as one sentence run: the `#` already stripped by the parser. */
const joinComment = (comment) => String(comment ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ');

/**
 * The first word begins a sentence, so a plain lower-case English word is capitalised; a name that
 * only looks like one (`pg_up`, `up{job=...}`, `age(...)`) is left as written.
 */
const capitalised = (text) => text.replace(/^[a-z]+(?=[\s,-])/, (word) => word[0].toUpperCase() + word.slice(1));

/** The threshold's wording, from the node that is the rule's condition. */
function thresholdOf(rule, nodes) {
  const text = (node) => {
    const model = node.model;
    if (model.type === 'reduce') return `${model.reducer}(${model.expression})`;
    if (model.type === 'threshold') {
      if (model.conditions?.length !== 1) fail(`${rule.uid}: ${node.refId} has more than one threshold condition`);
      const { type, params } = model.conditions[0].evaluator;
      const input = nodes.get(model.expression);
      if (!input) fail(`${rule.uid}: ${node.refId} reads ${model.expression}, which is not a node`);
      const subject = text(input);
      const [a, b] = params;
      if (type === 'gt') return `${subject} above ${a}`;
      if (type === 'lt') return `${subject} below ${a}`;
      if (type === 'within_range') return `${subject} between ${a} and ${b}`;
      if (type === 'outside_range') return `${subject} outside ${a} to ${b}`;
      return fail(`${rule.uid}: ${node.refId} uses the evaluator ${type}, which this script cannot say in words`);
    }
    if (model.type === 'math') {
      // `$B` is a node's value: say what the node is instead.
      return model.expression.replace(/\$(\w+)/g, (_, ref) => {
        const named = nodes.get(ref);
        if (!named) fail(`${rule.uid}: ${node.refId} names $${ref}, which is not a node`);
        return text(named);
      });
    }
    return fail(`${rule.uid}: ${node.refId} is a ${model.type} node, which this script cannot say in words`);
  };
  const condition = nodes.get(rule.condition);
  if (!condition) fail(`${rule.uid}: its condition ${rule.condition} is not a node`);
  return text(condition);
}

/** The queries a rule runs, as written, in file order: the nodes a datasource answers. */
function queriesOf(rule) {
  const queries = [];
  for (const node of rule.data) {
    if (node.datasourceUid === '__expr__') continue;
    const language = LANGUAGES[node.datasourceUid];
    if (!language) fail(`${rule.uid}: ${node.refId} reads the datasource ${node.datasourceUid}, which this script cannot name`);
    const text = String(node.model.rawSql ?? node.model.expr ?? '').trim();
    if (!text) fail(`${rule.uid}: ${node.refId} has no query text`);
    queries.push({ ref: node.refId, datasource: node.datasourceUid, language, text });
  }
  if (queries.length === 0) fail(`${rule.uid}: it runs no query`);
  return queries;
}

export function build(sourceText) {
  const YAML = createRequire(join(REPO_ROOT, 'frontend', 'package.json'))('yaml');
  const doc = YAML.parseDocument(sourceText);
  if (doc.errors.length) fail(`${SOURCE} does not parse: ${doc.errors[0].message}`);

  const groups = [];
  const rules = [];
  for (const group of doc.get('groups').items) {
    const name = group.get('name');
    groups.push({ name, interval: group.get('interval') });
    const list = group.get('rules');
    list.items.forEach((item, index) => {
      const rule = item.toJSON();
      if (!UID.test(String(rule.uid ?? ''))) fail(`${name}: a rule has the uid ${JSON.stringify(rule.uid)}, which is not a Grafana uid`);
      if (!rule.title) fail(`${rule.uid}: it has no title`);

      // The first rule of a group carries its comment on the list, the others on themselves.
      const comment = joinComment(index === 0 ? (item.commentBefore ?? list.commentBefore) : item.commentBefore);
      const split = /^([^:`]{3,80}): (.+)$/.exec(comment);
      if (!split) fail(`${rule.uid}: the comment above it must read "<title>: what it fires on", and it reads ${JSON.stringify(comment)}`);
      const description = capitalised(split[2]);
      const fires = description.split(/(?<=[.!?])\s+(?=[A-Z`])/)[0];

      const labels = rule.labels ?? {};
      const severity = labels.severity ?? 'warning';
      if (!SEVERITIES.includes(severity)) fail(`${rule.uid}: its severity is ${severity}`);
      const subject = labels.entity_type ?? 'device';
      if (!SUBJECTS.includes(subject)) fail(`${rule.uid}: its entity_type is ${subject}`);
      const summary = String(rule.annotations?.summary ?? '').trim();
      if (!summary) fail(`${rule.uid}: it has no summary annotation`);
      if (!rule.for) fail(`${rule.uid}: it has no for`);

      const nodes = new Map(rule.data.map((node) => [node.refId, node]));
      rules.push({
        uid: rule.uid,
        title: rule.title,
        group: name,
        evaluator: 'grafana',
        severity,
        subject,
        hold: rule.for,
        fires,
        description,
        queries: queriesOf(rule),
        threshold: thresholdOf(rule, nodes),
        labels,
        summary,
      });
    });
  }

  for (const key of ['uid', 'title']) {
    const seen = new Set();
    for (const rule of rules) {
      if (seen.has(rule[key])) fail(`two rules have the ${key} ${rule[key]}`);
      seen.add(rule[key]);
    }
  }

  return `${JSON.stringify({
    generated: `Written by scripts/generate-built-in-alerts.mjs from ${SOURCE}. Do not edit: change the file and run the script.`,
    source: SOURCE,
    groups,
    rules,
  }, null, 2)}\n`;
}

// Run as a script, not when a test imports build().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const wanted = build(readFileSync(join(REPO_ROOT, SOURCE), 'utf8'));
  if (process.argv.includes('--check')) {
    let have = null;
    try { have = readFileSync(join(REPO_ROOT, TARGET), 'utf8'); } catch { /* absent counts as stale */ }
    if (have !== wanted) fail(`${TARGET} is stale: run node scripts/generate-built-in-alerts.mjs and commit it`);
    console.log(`${TARGET} is current.`);
  } else {
    writeFileSync(join(REPO_ROOT, TARGET), wanted);
    console.log(`Wrote ${TARGET}.`);
  }
}
