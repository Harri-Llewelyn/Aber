/**
 * The blocks the OPC UA vocabulary is seeded in: which block an entry lands in, how a group is
 * registered and reworded, what a released block is held to, and what the generator writes.
 *
 *     node --test scripts/lib/opcua-seed-blocks.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BLOCKS, applyPlan, groupUuid, isUnreleased, planBlocks, readDigestRegion, REGIONS
} from './opcua-seed-blocks.mjs'

const BLOCK_LIST = [{ since: '0100', file: 'first.sql' }, { since: '0200', file: 'second.sql' }]

const row = (spec, name, group, since) => ({
  since,
  spec,
  group,
  statement:
    `INSERT INTO public.opcua_vocabulary VALUES ('${name}', '${spec}', 'nsu=${spec};i=1', 'text', 'Double', NULL, 'nsu=${spec};i=1')\n` +
    'ON CONFLICT (companion_spec, name) DO UPDATE SET\n  node_id     = EXCLUDED.node_id;'
})

const plan = (rows, groups, blocks = BLOCK_LIST) =>
  planBlocks({ rows, groups: new Map(Object.entries(groups)), generatedSpecs: [...new Set(rows.map((r) => r.spec))], blocks })

const SKELETON = Object.values(REGIONS).map((region) => `${region.begin}\n${region.end}\n`).join('\n')

test('an entry is seeded by the block it names, and one that names none by the first', () => {
  const [first, second] = plan(
    [row('A', 'one', 'G'), row('A', 'two', 'G', '0100'), row('B', 'three', 'H', '0200')],
    { G: 'the g group', H: 'the h group' }
  )
  assert.equal(first.vocabulary.rows, 2)
  assert.equal(second.vocabulary.rows, 1)
  assert.match(first.vocabulary.body, /VALUES \('one', 'A'/)
  assert.match(first.vocabulary.body, /VALUES \('two', 'A'/)
  assert.doesNotMatch(first.vocabulary.body, /'three'/)
  assert.match(second.vocabulary.body, /VALUES \('three', 'B'/)
})

test('an entry that names a block BLOCKS does not list is refused', () => {
  assert.throws(() => plan([row('A', 'one', 'G', '0999')], { G: 'g' }), /block 0999/)
})

test('a group is registered by the first block that has an entry in it, and not again', () => {
  const [first, second] = plan(
    [row('A', 'one', 'G', '0100'), row('B', 'two', 'G', '0200'), row('B', 'three', 'H', '0200')],
    { G: 'the g group', H: 'the h group' }
  )
  assert.match(first.groups.body, /'G', 'the g group'/)
  assert.equal(first.groups.rows, 1)
  assert.doesNotMatch(second.groups.body, /'G'/)
  assert.match(second.groups.body, /'H', 'the h group'/)
  assert.match(first.groups.body, new RegExp(groupUuid('G')))
})

test('a group with no description is left to the hand-written row that registers it', () => {
  const [first] = plan([row('A', 'one', 'Machine', '0100')], { Machine: null })
  assert.equal(first.groups.rows, 0)
  assert.equal(first.groups.body, '')
})

test('a reworded group keeps its first description in the block that registered it and is updated by the later one', () => {
  const reworded = { description: 'the new text', was: 'the old text', since: '0200' }
  const [first, second] = plan(
    [row('A', 'one', 'G', '0100'), row('B', 'two', 'G', '0200')],
    { G: reworded }
  )
  assert.match(first.groups.body, /'G', 'the old text', 'OPC UA'\)\nON CONFLICT DO NOTHING;/)
  assert.doesNotMatch(first.groups.body, /UPDATE/)
  assert.equal(second.groups.rows, 1)
  assert.equal(
    second.groups.body,
    `UPDATE public.metric_groups SET description = 'the new text'\n WHERE id = '${groupUuid('G')}' AND description = 'the old text';`
  )
})

test('a reworded group the first block never needed is registered with the new text, and has no UPDATE', () => {
  const [first, second] = plan(
    [row('B', 'two', 'G', '0200')],
    { G: { description: 'the new text', was: 'the old text', since: '0200' } }
  )
  assert.equal(first.groups.rows, 0)
  assert.match(second.groups.body, /'G', 'the new text'/)
  assert.doesNotMatch(second.groups.body, /UPDATE/)
})

test('a rewording names its old text and its block, and a group an entry uses must be defined', () => {
  assert.throws(
    () => plan([row('A', 'one', 'G')], { G: { description: 'new', since: '0200' } }),
    /the text it replaces/
  )
  assert.throws(
    () => plan([row('A', 'one', 'G')], { G: { description: 'new', was: 'old', since: '0999' } }),
    /the block that carries the change/
  )
  assert.throws(() => plan([row('A', 'one', 'G')], {}), /no group definition for G/)
})

test('an apostrophe in a description is doubled, as SQL needs it', () => {
  const [first] = plan([row('A', 'one', 'G')], { G: "the laser's state" })
  assert.match(first.groups.body, /'the laser''s state'/)
})

test("each block's table comment names the specifications seeded up to it", () => {
  const [first, second] = plan(
    [row('OPC 1 One', 'one', 'G', '0100'), row('OPC 2 Two', 'two', 'G', '0200')],
    { G: 'g' }
  )
  assert.match(first.comment.body, /data points: OPC 1 One\. /)
  assert.doesNotMatch(first.comment.body, /OPC 2 Two/)
  assert.match(second.comment.body, /data points: OPC 1 One, OPC 2 Two\. /)
})

test('the plan is written into the three regions, and a second application changes nothing', () => {
  const [first] = plan([row('A', 'one', 'G')], { G: 'g' })
  const written = applyPlan(SKELETON, first)
  assert.deepEqual(written.changed, ['metric_groups', 'opcua_vocabulary', 'table comment'])
  const again = applyPlan(written.text, first)
  assert.deepEqual(again.changed, [])
  assert.equal(again.text, written.text)
})

test('a block that has moved names the regions that differ', () => {
  const [first] = plan([row('A', 'one', 'G')], { G: 'g' })
  const written = applyPlan(SKELETON, first).text
  const [moved] = plan([row('A', 'one', 'G'), row('A', 'two', 'G')], { G: 'g' })
  assert.deepEqual(applyPlan(written, moved).changed, ['opcua_vocabulary'])
  const [reworded] = plan([row('A', 'one', 'G')], { G: 'another text' })
  assert.deepEqual(applyPlan(written, reworded).changed, ['metric_groups'])
})

test('a region the file lacks is refused, naming the file', () => {
  const [first] = plan([row('A', 'one', 'G')], { G: 'g' })
  assert.throws(() => applyPlan('-- nothing here\n', first), /first\.sql/)
})

test('a written region reads back with its stamp, and an edit to its body shows', () => {
  const [first] = plan([row('A', 'one', 'G'), row('A', 'two', 'G')], { G: 'g' })
  const text = applyPlan(SKELETON, first).text
  const read = readDigestRegion(text, REGIONS.vocabulary)
  assert.equal(read.rows, 2)
  assert.equal(read.actual, read.digest)
  const edited = readDigestRegion(text.replace("'text'", "'other text'"), REGIONS.vocabulary)
  assert.notEqual(edited.actual, edited.digest)
  assert.equal(readDigestRegion('no markers', REGIONS.vocabulary), null)
})

test('a block may be written while its migration has a note in unreleased/migrations, and not after', () => {
  const root = mkdtempSync(join(tmpdir(), 'opcua-seed-blocks-'))
  try {
    mkdirSync(join(root, 'unreleased', 'migrations'), { recursive: true })
    assert.equal(isUnreleased({ since: '0300' }, root), false)
    writeFileSync(join(root, 'unreleased', 'migrations', '0300.md'), '### A section (0300)\n')
    assert.equal(isUnreleased({ since: '0300' }, root), true)
    assert.equal(isUnreleased({ since: '0002' }, root), false)
  } finally { rmSync(root, { recursive: true }) }
})

test('the blocks are in migration order, and each names a migration of its own number', () => {
  assert.deepEqual(BLOCKS.map((block) => block.since), ['0002', '0300'])
  for (const block of BLOCKS) assert.match(block.file, new RegExp(`/${block.since}_`))
})
