/**
 * The blocks the OPC UA vocabulary is seeded in, and what each one holds.
 *
 * scripts/generate-opcua-vocabulary.mjs writes them and scripts/check-opcua-seed-sync.mjs verifies
 * them. Neither reads the network here: this file is the part of the two that is plain data in, plain
 * text out, so scripts/lib/opcua-seed-blocks.test.mjs can hold it to its rules.
 *
 * A BLOCK is one migration's share of the vocabulary. Three marked regions of the file hold it:
 *
 *   * the `metric_groups` rows the block registers, and the rewording of a group registered earlier;
 *   * the `opcua_vocabulary` rows the block seeds;
 *   * the COMMENT on the table, naming every companion specification seeded up to and including it.
 *
 * WHY MORE THAN ONE. A released migration is never edited (supabase/README.md), and 0002 is released.
 * A vocabulary that grows therefore grows in a block of the migration that adds it, and every block
 * before it stays exactly as it was released. BLOCKS lists them oldest first. To add the next
 * expansion, add a block here, give its entries `since: '<its number>'` in the generator, and put the
 * three marked regions in its migration (0300 is the model).
 *
 * WHICH BLOCK SEEDS AN ENTRY is the entry's `since`. An entry with none belongs to the first block.
 * Each block is written from its own entries and no others.
 *
 * A BLOCK IS WRITTEN ONLY WHILE ITS MIGRATION IS UNRELEASED, which is while the migration's note is
 * in unreleased/migrations/ (the release folds the note into supabase/README.md and deletes it). A
 * released block is only verified: the generator builds what the block would hold now, and a block
 * that differs stops the run with the regions that moved. So a corrected description or a NodeSet that
 * changed under its pin can never rewrite a migration that has shipped. What this does not do yet is
 * revise a row a released block seeded: that needs a later block to seed the changed row beside the
 * original (the rows are ON CONFLICT ... DO UPDATE, so it would become the one an installed database
 * holds), and an entry that can name both. Build it with the first correction that needs it.
 *
 * A GROUP is registered by the first block that has an entry in it, `ON CONFLICT DO NOTHING`, with
 * the description it had then. Its description can change after that. The change is a `{ description,
 * was, since }` definition: the block named by `since` carries an UPDATE of the row, guarded on `was`,
 * the text the earlier block registered, so a description an Administrator has edited is left as it
 * is and a replay changes nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { COMMENT_BEGIN, COMMENT_END, tableCommentStatement } from './opcua-vocabulary-comment.mjs';

export const BLOCKS = [
  { since: '0002', file: 'supabase/migrations/0002_seed_data.sql' },
  {
    since: '0300',
    file: 'supabase/migrations/0300_the_opc_ua_vocabulary_seeds_more_of_what_its_nodesets_describe.sql'
  }
];

/** The marked regions of a block's file. Each pair appears once in the file. */
export const REGIONS = {
  groups: {
    label: 'metric_groups',
    begin: '-- >>> BEGIN GENERATED opcua_metric_groups',
    end: '-- <<< END GENERATED opcua_metric_groups'
  },
  vocabulary: {
    label: 'opcua_vocabulary',
    begin: '-- >>> BEGIN GENERATED opcua_vocabulary_rows',
    end: '-- <<< END GENERATED opcua_vocabulary_rows'
  },
  comment: { label: 'table comment', begin: COMMENT_BEGIN, end: COMMENT_END }
};

export const DIGEST_ANCHOR = 'CI verifies the digest above.';

export const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

export const digestOf = (body) => createHash('sha256').update(body).digest('hex').slice(0, 16);

/**
 * A group's primary key, derived from its name so re-running is stable and the diff stays empty; a
 * random uuid would rewrite every line on every run. The salt is fixed from 1.0 on: changing it
 * changes every id a block seeds, and an installed database keeps the ids it was seeded with.
 */
export const groupUuid = (name) => {
  const hex = createHash('sha256').update(`aber.metric_group.${name}`).digest('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex.slice(16, 17), 16) & 0x3 | 0x8).toString(16)) + hex.slice(17, 20),
    hex.slice(20, 32)
  ].join('-');
};

/** Whether the block's migration has no section in supabase/README.md yet, so its block may be written. */
export const isUnreleased = (block, root) => existsSync(join(root, 'unreleased', 'migrations', `${block.since}.md`));

/**
 * The text of a region: the line the BEGIN marker is on, up to the END marker. Null when the file
 * has no such pair, or has them the wrong way round.
 */
export function regionAt(text, region) {
  const beginAt = text.indexOf(region.begin);
  const endAt = text.indexOf(region.end);
  return beginAt < 0 || endAt < beginAt ? null : { beginAt, endAt };
}

/** The file with the region's marker line and body replaced by `header` and `body`. */
export function spliceRegion(text, region, header, body, where) {
  const at = regionAt(text, region);
  if (!at) {
    throw new Error(`markers not found in ${where}. Expected a ${region.label} region delimited by:\n  ${region.begin}\n  ${region.end}`);
  }
  return text.slice(0, at.beginAt) + header + '\n' + body + '\n' + text.slice(at.endAt);
}

/** A digest region as the file holds it: its stamp, and the body the digest covers. Null when malformed. */
export function readDigestRegion(text, region) {
  const at = regionAt(text, region);
  if (!at) return null;
  const headerLine = text.slice(at.beginAt, text.indexOf('\n', at.beginAt));
  const stamp = headerLine.match(/(\d+) rows, sha256:([0-9a-f]+)/);
  const anchor = text.indexOf(DIGEST_ANCHOR, at.beginAt);
  if (!stamp || anchor < 0 || anchor > at.endAt) return { malformed: headerLine };
  const body = text.slice(text.indexOf('\n', anchor) + 1, at.endAt).replace(/\n$/, '');
  return { rows: Number(stamp[1]), digest: stamp[2], body, actual: digestOf(body) };
}

const vocabularyHeader = (rows, digest) =>
  `${REGIONS.vocabulary.begin} -- ${rows} rows, sha256:${digest}\n` +
  `-- GENERATED from the OPC Foundation NodeSet2 XML by scripts/generate-opcua-vocabulary.mjs.\n` +
  `-- Do not edit these rows by hand: change ENTRIES in that script and re-run it. Browse names,\n` +
  `-- datatypes and NodeIds are read from the NodeSet; the selection, prose and units are curated.\n` +
  `-- ${DIGEST_ANCHOR}`;

const groupsHeader = (rows, digest) =>
  `${REGIONS.groups.begin} -- ${rows} rows, sha256:${digest}\n` +
  `-- GENERATED by scripts/generate-opcua-vocabulary.mjs. ${DIGEST_ANCHOR}`;

const commentHeader = (first) =>
  `${REGIONS.comment.begin}\n` +
  (first
    ? '-- GENERATED by scripts/generate-opcua-vocabulary.mjs from every opcua_vocabulary row in this file.'
    : '-- GENERATED by scripts/generate-opcua-vocabulary.mjs from every opcua_vocabulary row this migration and the ones before it seed.');

/**
 * A group definition as the generator's SPECS write it: `null` (a hand-written row registers it), a
 * description, or `{ description, was, since }` for a description that changed.
 */
function normaliseGroup(name, definition, blocks) {
  if (definition === null) return { name, registered: false };
  if (typeof definition === 'string') return { name, registered: true, description: definition };
  const { description, was, since } = definition;
  if (!description || !was || !blocks.some((b) => b.since === since)) {
    throw new Error(`group ${name}: a changed description names its new text, the text it replaces (was) and the block that carries the change (since)`);
  }
  return { name, registered: true, description, was, since };
}

/**
 * What each block holds, from the entries and the groups. Pure: `rows` are the resolved entries, in
 * the order they are written (`{ since, spec, group, statement }`, the statement being the
 * INSERT), `groups` maps a group's name to its definition, and `generatedSpecs` names the
 * specifications the generator verifies. Returns one plan per block, in BLOCKS order, each region
 * as the `{ header, body, rows }` it is written as.
 */
export function planBlocks({ rows, groups, generatedSpecs, blocks = BLOCKS }) {
  const index = (since) => {
    const at = blocks.findIndex((b) => b.since === since);
    if (at < 0) throw new Error(`an entry is seeded by block ${since}, which BLOCKS does not list`);
    return at;
  };
  const sinceOf = (row) => row.since ?? blocks[0].since;

  const firstUse = new Map();
  for (const row of rows) {
    const at = index(sinceOf(row));
    if (!firstUse.has(row.group) || at < firstUse.get(row.group)) firstUse.set(row.group, at);
  }

  const inserts = blocks.map(() => []);
  const updates = blocks.map(() => []);
  for (const [name, at] of [...firstUse.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!groups.has(name)) throw new Error(`no group definition for ${name}`);
    const group = normaliseGroup(name, groups.get(name), blocks);
    if (!group.registered) continue;
    const changesLater = group.since !== undefined && index(group.since) > at;
    const registered = changesLater ? group.was : group.description;
    inserts[at].push(
      `INSERT INTO public.metric_groups (id, name, description, standard) VALUES ` +
      `(${sqlString(groupUuid(name))}, ${sqlString(name)}, ${sqlString(registered)}, 'OPC UA')\n` +
      `ON CONFLICT DO NOTHING;`);
    if (changesLater) {
      updates[index(group.since)].push(
        `UPDATE public.metric_groups SET description = ${sqlString(group.description)}\n` +
        ` WHERE id = ${sqlString(groupUuid(name))} AND description = ${sqlString(group.was)};`);
    }
  }

  return blocks.map((block, at) => {
    const own = rows.filter((row) => sinceOf(row) === block.since);
    const upTo = rows.filter((row) => index(sinceOf(row)) <= at);
    const vocabularyBody = own.map((row) => row.statement).join('\n');
    const groupStatements = [...inserts[at], ...updates[at]];
    const groupsBody = groupStatements.join('\n');
    return {
      block,
      vocabulary: {
        header: vocabularyHeader(own.length, digestOf(vocabularyBody)),
        body: vocabularyBody,
        rows: own.length
      },
      groups: {
        header: groupsHeader(groupStatements.length, digestOf(groupsBody)),
        body: groupsBody,
        rows: groupStatements.length
      },
      comment: {
        header: commentHeader(at === 0),
        body: tableCommentStatement(upTo.map((row) => row.statement).join('\n'), generatedSpecs)
      }
    };
  });
}

/**
 * The block's file as the plan says it should read, and the regions that differ from what it holds.
 * `text` has LF line ends.
 */
export function applyPlan(text, plan) {
  let next = text;
  const changed = [];
  for (const [name, region] of Object.entries(REGIONS)) {
    const at = regionAt(next, region);
    const before = at ? next.slice(at.beginAt, at.endAt) : null;
    next = spliceRegion(next, region, plan[name].header, plan[name].body, plan.block.file);
    const wrote = next.slice(regionAt(next, region).beginAt, regionAt(next, region).endAt);
    if (before !== wrote) changed.push(region.label);
  }
  return { text: next, changed };
}
