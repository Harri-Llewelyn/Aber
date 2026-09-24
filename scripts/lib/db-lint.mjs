/**
 * Lint a migrated database with the two tools that judge what the schema IS rather than what it
 * depends on: supabase/splinter (the SQL behind Studio's Security and Performance Advisors) and
 * plpgsql_check (every PL/pgSQL body, statically). Findings are compared with an allow-list keyed
 * by a stable key, so only something new fails; an allow-list entry that no longer matches is
 * reported, because a stale one would hide the same finding if it came back.
 *
 * splinter carries no licence, so it is not vendored: it is fetched at a pinned commit and refused
 * unless its SHA-256 matches, then cached under .cache/lint/.
 *
 * Callers supply `sql(text) -> stdout`, which runs a script with psql -At against the database.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SPLINTER = {
  commit: 'e74a9e36cb12258cb67d1464bc1cb196e9cd8446',
  sha256: 'd8d558baad3e03832e521c527907fa50a9a172fabd899dd0f5c2504a5a0e9349',
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

export async function splinterSql (repo) {
  const dir = join(repo, '.cache', 'lint')
  const file = join(dir, `splinter-${SPLINTER.commit.slice(0, 12)}.sql`)
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8')
    if (sha256(text) === SPLINTER.sha256) return text
  }
  const url = `https://raw.githubusercontent.com/supabase/splinter/${SPLINTER.commit}/splinter.sql`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not fetch splinter at ${SPLINTER.commit}: HTTP ${res.status}`)
  const text = await res.text()
  if (sha256(text) !== SPLINTER.sha256) {
    throw new Error(`splinter at ${SPLINTER.commit} does not match its pinned SHA-256; refusing to run it`)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, text)
  return text
}

/**
 * splinter is a preamble (a `set local` and a DO block that fills a GUC) followed by one
 * parenthesised UNION ALL with no terminating semicolon. Wrapped so the rows come back as one JSON
 * array, inside a transaction the `set local` needs and that is rolled back.
 */
export function splinterScript (text) {
  const at = text.search(/^\($/m)
  if (at < 0) throw new Error('splinter.sql has changed shape: no top-level "(" starting the query')
  const preamble = text.slice(0, at)
  const query = text.slice(at).trim().replace(/;\s*$/, '')
  return `BEGIN;\n${preamble}\nSELECT coalesce(jsonb_agg(l), '[]'::jsonb) FROM (\n${query}\n) l;\nROLLBACK;\n`
}

/**
 * Every PL/pgSQL function in `schemas`, checked. A trigger function is checked against EACH table
 * it is attached to (plpgsql_check needs the row type, and a branch on TG_TABLE_NAME means a
 * finding can hold for one table and not another), and the table is part of the finding; one
 * attached to none is listed as unchecked rather than skipped silently. The extension is created
 * inside the transaction and rolled back with it, so the database is left as it was.
 */
export function plpgsqlCheckScript (schemas = ['public']) {
  const list = schemas.map((s) => `'${s}'`).join(', ')
  return `BEGIN;
CREATE EXTENSION IF NOT EXISTS plpgsql_check;
WITH fns AS (
  SELECT p.oid, p.oid::regprocedure::text AS function,
         p.prorettype = 'pg_catalog.trigger'::regtype AS is_trigger
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE n.nspname IN (${list}) AND l.lanname = 'plpgsql'
     AND p.prorettype <> 'pg_catalog.event_trigger'::regtype
), targets AS (
  SELECT f.oid, f.function, 0::oid AS relid FROM fns f WHERE NOT f.is_trigger
  UNION
  SELECT f.oid, f.function || ' on ' || t.tgrelid::regclass::text, t.tgrelid
    FROM fns f JOIN pg_catalog.pg_trigger t ON t.tgfoid = f.oid
   WHERE f.is_trigger
), findings AS (
  SELECT g.function, c.level, c.message, c.sqlstate, c.lineno
    FROM targets g
   CROSS JOIN LATERAL plpgsql_check_function_tb(
     g.oid, g.relid,
     fatal_errors => false, other_warnings => true, extra_warnings => true,
     performance_warnings => false, security_warnings => true) c
  UNION ALL
  SELECT f.function, 'unchecked', 'trigger function attached to no table', NULL, NULL
    FROM fns f
   WHERE f.is_trigger AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgfoid = f.oid)
)
SELECT coalesce(jsonb_agg(findings), '[]'::jsonb) FROM findings;
ROLLBACK;
`
}

const lastJson = (stdout) => {
  const line = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[')).pop()
  if (!line) throw new Error(`no JSON result in the lint output:\n${stdout.slice(-2000)}`)
  return JSON.parse(line)
}

/** splinter rows gated on (WARN, ERROR), keyed by splinter's own cache_key. */
export const splinterFindings = (stdout) => lastJson(stdout)
  .filter((r) => r.level === 'WARN' || r.level === 'ERROR')
  .map((r) => ({ key: r.cache_key, level: r.level, name: r.name, text: r.detail }))

/** plpgsql_check rows keyed by function, level and message: line numbers move with every edit. */
export const plpgsqlFindings = (stdout) => lastJson(stdout).map((r) => ({
  key: `${r.function} | ${r.level} | ${r.message}`,
  level: r.level,
  name: r.function,
  text: `line ${r.lineno ?? '?'}: ${r.message}`,
}))

/**
 * Compare findings with the allow-list section. Returns { unexpected, stale, allowed }.
 * The allow-list maps a key to the reason it is accepted, so every exemption says why.
 */
export function judge (findings, allowed = {}) {
  const found = new Set(findings.map((f) => f.key))
  return {
    unexpected: findings.filter((f) => !(f.key in allowed)),
    allowed: findings.filter((f) => f.key in allowed),
    stale: Object.keys(allowed).filter((k) => !found.has(k)),
  }
}

/** Print one tool's verdict; returns true when nothing unexpected was found. */
export function report (tool, verdict, { dim = (s) => s, red = (s) => s, green = (s) => s } = {}) {
  const { unexpected, allowed, stale } = verdict
  for (const f of unexpected) console.log(red(`  NEW   ${tool}: ${f.level} ${f.name}`) + dim(`\n        ${f.text}\n        key: ${f.key}`))
  for (const k of stale) console.log(dim(`  stale ${tool}: allow-list entry no longer found, delete it: ${k}`))
  const summary = `${tool}: ${unexpected.length} new, ${allowed.length} allowed, ${stale.length} stale`
  console.log(unexpected.length ? red(`  ${summary}`) : green(`  ${summary}`))
  return unexpected.length === 0
}
