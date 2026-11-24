/**
 * What an appliance deploys when the forge holds a tag named as the branch it tracks.
 *
 *     node --test scripts/lib/flow-sync-branch.test.mjs
 *
 * The subject is `flow-sync.mjs` as it ships, run with `--once` against a bare repository on this
 * disk and a stand-in for Node-RED's two admin calls. Git takes a short name for a tag before a
 * branch, so a command that names `main` short deploys the tag's commit, which nobody approved. The
 * forge refuses such a tag to people and keys (supabase/functions/_shared/forge.ts); these are for
 * the appliance that meets one anyway.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FLOW_SYNC = join(REPO, 'forge', 'gateway-platform', 'appliance', 'flow-sync.mjs');
const SKIP = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'needs git on PATH';

/** Forward slashes: these become Git remotes and environment variables. */
const posix = (p) => p.replace(/\\/g, '/');
const flow = (name) => `${JSON.stringify([{ id: name, type: 'tab', label: name }])}\n`;

let root;
let nodeRed;
let reloads = 0;
const env = () => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: `${root}/gitconfig`,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid',
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(async () => {
  if (SKIP) return;
  root = posix(mkdtempSync(join(tmpdir(), 'aber-flow-sync-')));
  writeFileSync(`${root}/gitconfig`, '');
  nodeRed = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/auth/token') return res.end(JSON.stringify({ access_token: 'not-a-real-key' }));
    reloads += 1;
    res.statusCode = 204;
    res.end();
  });
  await new Promise((done) => nodeRed.listen(0, '127.0.0.1', done));
});

after(() => {
  if (SKIP) return;
  nodeRed.close();
  rmSync(root, { recursive: true, force: true });
});

/** A gateway's repository at the forge, with `main` carrying one approved flow. */
function forge(name) {
  const bare = `${root}/${name}.git`;
  const work = `${root}/${name}-work`;
  mkdirSync(work, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', bare);
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(`${work}/${path}`, text);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', message);
    return git(work, 'rev-parse', 'HEAD');
  };
  const at = {
    bare,
    ref: (ref) => {
      const [line] = git(bare, 'for-each-ref', '--format=%(objectname)', ref).split('\n');
      return line || null;
    },
    /** What an approved merge does. */
    approve: (files, message = 'approved') => {
      if (at.ref('refs/heads/main')) git(work, 'checkout', '-q', '-f', 'main');
      const sha = commit(files, message);
      git(work, 'push', '-q', 'origin', 'refs/heads/main:refs/heads/main');
      return sha;
    },
    /** A commit on top of `main` that nobody approved, pushed as a tag of the given name. */
    plant: (tag, files) => {
      git(work, 'checkout', '-q', '-f', '--detach', 'refs/heads/main');
      const sha = commit(files, 'never approved');
      git(work, 'push', '-q', 'origin', `${sha}:refs/tags/${tag}`);
      return sha;
    },
  };
  at.approve({ 'flows.json': flow('approved-1') });
  return at;
}

/** An enrolled appliance's /data, as bootstrap.mjs leaves it, on the platform flow. */
function appliance(name, repository, branch = 'main') {
  const data = `${root}/${name}`;
  mkdirSync(`${data}/gitops`, { recursive: true });
  writeFileSync(`${data}/flows.json`, flow('enrolment'));
  writeFileSync(`${data}/gitops/repository.json`, JSON.stringify({ ssh_url: repository.bare, branch }));
  writeFileSync(`${data}/gitops/known_hosts`, 'forge ssh-ed25519 AAAA\n');
  writeFileSync(`${data}/gitops/id_ed25519`, 'not a real key\n');
  writeFileSync(`${data}/gitops/nodered.json`, JSON.stringify({ username: 'sync', password: 'not-a-real-key' }));
  return {
    data,
    checkout: `${data}/gitops/repo`,
    running: () => readFileSync(`${data}/flows.json`, 'utf8'),
    head: () => git(`${data}/gitops/repo`, 'rev-parse', 'HEAD'),
    /** One pass, as the container runs it. Not spawnSync: the stand-in answers from this process. */
    pass: () => new Promise((done) => {
      const child = spawn(process.execPath, [FLOW_SYNC, '--once'], {
        env: { ...env(), NODE_RED_DATA_DIR: data, NODE_RED_URL: `http://127.0.0.1:${nodeRed.address().port}` },
      });
      let said = '';
      child.stdout.on('data', (text) => { said += text; });
      child.stderr.on('data', (text) => { said += text; });
      child.on('close', (code) => done({ code, said }));
    }),
  };
}

test('a tag named main is not deployed, and the next approved merge is', { skip: SKIP }, async () => {
  const repository = forge('followed');
  const box = appliance('followed-data', repository);
  await box.pass();
  assert.equal(box.running(), flow('approved-1'));
  const approved = repository.ref('refs/heads/main');

  const tagged = repository.plant('main', { 'flows.json': flow('never-approved'), 'custom.yml': '- hosts: all\n' });
  assert.notEqual(repository.ref('refs/tags/main'), approved);
  const before = reloads;
  const { said } = await box.pass();
  assert.equal(box.running(), flow('approved-1'), said);
  assert.equal(box.head(), approved, said);
  assert.equal(existsSync(`${box.checkout}/custom.yml`), false, 'the converge script would run the tag\'s custom.yml as root');
  assert.equal(reloads, before);

  const merged = repository.approve({ 'flows.json': flow('approved-2') });
  await box.pass();
  assert.equal(box.running(), flow('approved-2'));
  assert.equal(box.head(), merged);
  assert.equal(repository.ref('refs/tags/main'), tagged);
});

test('a first run beside a tag named main checks out the branch, and brings in no tag', { skip: SKIP }, async () => {
  const repository = forge('first');
  repository.plant('main', { 'flows.json': flow('never-approved') });
  const box = appliance('first-data', repository);
  const { said } = await box.pass();
  assert.equal(box.running(), flow('approved-1'), said);
  assert.equal(box.head(), repository.ref('refs/heads/main'));
  assert.equal(git(box.checkout, 'tag', '--list'), '');
});

test('the report reaches its branch beside a tag of the same name, first and after', { skip: SKIP }, async () => {
  const repository = forge('reported');
  const tagged = repository.plant('appliance', { 'flows.json': flow('never-approved') });
  const box = appliance('reported-data', repository);
  const { said } = await box.pass();
  assert.doesNotMatch(said, /report failed/);
  const report = repository.ref('refs/heads/appliance');
  assert.ok(report, said);
  assert.equal(git(repository.bare, 'show', `${report}:flows.json`), flow('approved-1').trim());

  writeFileSync(`${box.data}/flows.json`, flow('edited-on-the-box'));
  const second = await box.pass();
  assert.doesNotMatch(second.said, /report failed/);
  const next = repository.ref('refs/heads/appliance');
  assert.notEqual(next, report);
  assert.equal(git(repository.bare, 'rev-parse', `${next}^`), report);
  assert.equal(git(repository.bare, 'show', `${next}:flows.json`), flow('edited-on-the-box').trim());
  assert.equal(repository.ref('refs/tags/appliance'), tagged);
});

test('an appliance that already followed such a tag refuses the branch until its checkout is removed', { skip: SKIP }, async () => {
  const repository = forge('taken');
  const box = appliance('taken-data', repository);
  await box.pass();
  // As the puller of 1.9.0 and before left it: the tag's commit checked out and deployed.
  const tagged = repository.plant('main', { 'flows.json': flow('never-approved') });
  git(box.checkout, 'fetch', '-q', 'origin', 'refs/tags/main:refs/tags/main');
  git(box.checkout, 'checkout', '-q', '--force', '--detach', tagged);
  writeFileSync(`${box.data}/flows.json`, flow('never-approved'));
  writeFileSync(`${box.data}/gitops/deployed.json`, JSON.stringify({ revision: tagged }));

  const refused = await box.pass();
  assert.match(refused.said, /rewritten history/);
  assert.equal(box.running(), flow('never-approved'), 'recovery is a person\'s decision');

  rmSync(box.checkout, { recursive: true, force: true });
  const { said } = await box.pass();
  assert.equal(box.running(), flow('approved-1'), said);
  assert.equal(box.head(), repository.ref('refs/heads/main'));
});

test('an appliance told another branch refuses it, and reports what it goes on running', { skip: SKIP }, async () => {
  const repository = forge('told');
  const trunk = repository.plant('told', { 'flows.json': flow('on-trunk') });
  git(repository.bare, 'update-ref', 'refs/heads/trunk', trunk);
  git(repository.bare, 'update-ref', '-d', 'refs/tags/told');
  const box = appliance('told-data', repository, 'trunk');
  const { said } = await box.pass();
  assert.match(said, /REFUSING TO SYNC: .* names the branch 'trunk'/);
  assert.equal(box.running(), flow('enrolment'));
  assert.equal(existsSync(box.checkout), false);
  const report = repository.ref('refs/heads/appliance');
  assert.ok(report, said);
  assert.equal(git(repository.bare, 'show', `${report}:flows.json`), flow('enrolment').trim());
});

test('an appliance told no branch deploys main', { skip: SKIP }, async () => {
  const repository = forge('untold');
  const box = appliance('untold-data', repository, null);
  const { said } = await box.pass();
  assert.equal(box.running(), flow('approved-1'), said);
});
