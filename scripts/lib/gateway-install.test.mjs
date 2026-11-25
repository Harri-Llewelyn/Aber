/**
 * What the appliance's installer does with an `.env` a first run left, and how it ends when enrolment
 * fails or the project does not start.
 *
 *     node --test scripts/lib/gateway-install.test.mjs
 *
 * The subject is `install.sh` as the platform serves it, run whole with its folders in a temporary
 * one and what it installs, fetches and starts replaced by stand-ins on PATH. `docker compose up`
 * enrols when the `.env` holds the one token that is alive, as bootstrap does, so a run that kept a
 * dead token ends as it does on an appliance. Skipped where there is no Bash that runs as a POSIX
 * shell on this host's own files.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = join(REPO, 'forge', 'gateway-platform', 'install.sh');
const WINDOWS = process.platform === 'win32';

/** On Windows the first `bash` may be another system's, whose paths are not these. */
const uname = spawnSync('bash', ['-c', 'uname -s'], { encoding: 'utf8' });
const SKIP = uname.status !== 0 || (WINDOWS && !/^(MINGW|MSYS|CYGWIN)/.test(uname.stdout))
  ? 'needs Bash on PATH'
  : false;

/** Forward slashes: these go into a shell script and its environment. */
const posix = (p) => p.replace(/\\/g, '/');

const FIRST = 'a'.repeat(64);
const SECOND = 'b'.repeat(64);

/** Each stand-in, by the command it replaces. STUB_DIR is where they read and leave what the test asks about. */
const STUBS = {
  id: 'echo 0',
  'apt-get': ':',
  // The platform's two files. The .env's secret is generated per fetch, and only a live token is served.
  curl: `
    for arg in "$@"; do case "$arg" in "X-Enrolment-Token: "*) token="\${arg#X-Enrolment-Token: }" ;; esac; done
    while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
    [ "$token" = "$(cat "$STUB_DIR/alive")" ] || exit 22
    case "$url" in
      *file=env)
        echo fetched >> "$STUB_DIR/fetches"
        printf '# For one gateway\\nABER_SUPABASE_URL=http://platform\\nABER_ENROLLMENT_TOKEN=%s\\nNODERED_CREDENTIAL_SECRET=secret-%s\\nABER_GATEWAY_NAME=Press 1\\n' \\
          "$token" "$(wc -l < "$STUB_DIR/fetches" | tr -d ' ')" > "$out" ;;
      *) echo zip > "$out" ;;
    esac`,
  // python3 -m zipfile -e <zip> <folder>
  python3: 'mkdir -p "$5" && : > "$5/site.yml"',
  // The playbook's appliance role starts the project when it finds an .env and nothing running.
  'ansible-playbook': `
    [ ! -f "$STUB_DIR/broken-playbook" ] || { echo 'fatal: [localhost]: FAILED! => apt is locked'; exit 2; }
    [ -f "$COMPOSE_DIR/.env" ] || { echo none >> "$STUB_DIR/playbook"; exit 0; }
    sed -n 's/^ABER_ENROLLMENT_TOKEN=//p' "$COMPOSE_DIR/.env" >> "$STUB_DIR/playbook"
    [ -f "$STUB_DIR/running" ] || docker compose up -d --build || { echo 'fatal: [localhost]: FAILED!'; exit 2; }`,
  // Up starts bootstrap, which redeems the token it finds, once, unless this appliance has enrolled, and
  // fails when bootstrap does. Its container and its log stay for the next run, as on an appliance, until
  // the .env changes: Compose then makes a new one. The log holds the token here, which the real one does
  // not, to show whether a printed log is cleaned.
  docker: `
    log="$STUB_DIR/bootstrap.log"
    case "$*" in
      'compose ps -a -q bootstrap') [ ! -f "$STUB_DIR/container" ] || echo c0ffee; exit 0 ;;
      inspect*) cat "$STUB_DIR/container"; exit 0 ;;
      'compose logs --no-log-prefix bootstrap') [ ! -f "$log" ] || cat "$log"; exit 0 ;;
      'compose up '*) ;;
      *) exit 0 ;;
    esac
    if [ -f "$STUB_DIR/unpullable" ]; then echo 'Error response from daemon: pull access denied' >&2; exit 1; fi
    if [ -f "$STUB_DIR/unmountable" ]; then
      [ -f "$STUB_DIR/container" ] || echo 0001-01-01T00:00:00Z > "$STUB_DIR/container"
      echo 'Error response from daemon: failed to mount local volume' >&2
      exit 1
    fi
    [ ! -f "$DATA_DIR/.enrolled.json" ] || exit 0
    token="$(sed -n 's/^ABER_ENROLLMENT_TOKEN=//p' "$COMPOSE_DIR/.env")"
    [ ! -f "$STUB_DIR/redeemed" ] || [ "$(tail -n 1 "$STUB_DIR/redeemed")" = "$token" ] || rm -f "$log"
    echo "$token" >> "$STUB_DIR/redeemed"
    echo "2026-11-25T10:00:0$(wc -l < "$STUB_DIR/redeemed" | tr -d ' ').5Z" > "$STUB_DIR/container"
    echo "[bootstrap] enrolling with $token" >> "$log"
    why=
    [ ! -f "$STUB_DIR/spent" ] || why='the enrolment token was refused.'
    [ "$token" = "$(cat "$STUB_DIR/alive")" ] || why='the enrolment token was refused.'
    [ ! -f "$STUB_DIR/unreachable" ] || why='the platform is unreachable.'
    if [ -n "$why" ]; then
      echo "[bootstrap] FAILED: $why" >> "$log"
      echo 'service "bootstrap" did not complete successfully: exit 1' >&2
      exit 1
    fi
    mkdir -p "$DATA_DIR" && echo '{"sparkplug_id":"gwy1"}' > "$DATA_DIR/.enrolled.json"
    if [ -f "$STUB_DIR/port-taken" ]; then echo 'Bind for 0.0.0.0:1880 failed: port is already allocated' >&2; exit 1; fi`,
};

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A fresh machine, with `run(token)` pasting a command whose token that is. */
function machine() {
  const dir = posix(mkdtempSync(join(tmpdir(), 'aber-install-')));
  made.push(dir);
  const [bin, state, compose, stubs] = ['bin', 'state', 'opt', 'stubs'].map((name) => `${dir}/${name}`);
  for (const folder of [bin, `${state}/data`, compose, stubs]) mkdirSync(folder, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`);
    chmodSync(`${bin}/${name}`, 0o755);
  }
  // The folder is the playbook's own, so the script states it rather than reading it.
  const source = readFileSync(INSTALLER, 'utf8');
  const stated = 'local COMPOSE_DIR="/opt/aber-gateway"';
  assert.equal(source.split(stated).length, 2, `install.sh no longer states ${stated}`);
  const script = `${dir}/install.sh`;
  writeFileSync(script, source.replace(stated, `local COMPOSE_DIR="${compose}"`)
    .replaceAll('__PLATFORM_URL__', 'http://platform').replaceAll('__PUBLISHABLE_KEY__', 'public')
    .replaceAll('__GATEWAY_NAME__', 'Press 1').replaceAll('__SPARKPLUG_ID__', 'gwy1'));

  const env = `${compose}/.env`;
  const set = (name, is = true) => (is ? writeFileSync(`${stubs}/${name}`, '') : rmSync(`${stubs}/${name}`, { force: true }));
  const left = (name) => (existsSync(`${stubs}/${name}`) ? readFileSync(`${stubs}/${name}`, 'utf8').split('\n').filter(Boolean) : []);
  return {
    env,
    compose,
    enrolled: () => existsSync(`${state}/data/.enrolled.json`),
    text: () => readFileSync(env, 'utf8'),
    /** What each stand-in saw, in order. */
    redeemed: () => left('redeemed'),
    playbook: () => left('playbook'),
    /** The one token the platform accepts. */
    alive: (token) => writeFileSync(`${stubs}/alive`, token),
    /** Whether enrolment can reach the platform, and whether a service of the project is running. */
    reach: (can) => set('unreachable', !can),
    running: (is) => set('running', is),
    /** What goes wrong here: 'spent' (bootstrap's token is refused), 'unpullable', 'unmountable', 'port-taken' or 'broken-playbook'. */
    set,
    run(token) {
      const done = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ABER_STATE_DIR: state,
          COMPOSE_DIR: compose, DATA_DIR: `${state}/data`, STUB_DIR: stubs, ABER_ENROLMENT_TOKEN: token, ABER_CA_PIN: '',
        },
      });
      return { code: done.status, said: `${done.stdout}${done.stderr}` };
    },
  };
}

/** A machine whose first command wrote its .env and could not enrol, and whose second is now the live one. */
function reissued() {
  const at = machine();
  at.alive(FIRST);
  at.reach(false);
  const first = at.run(FIRST);
  assert.notEqual(first.code, 0, first.said);
  assert.match(at.text(), new RegExp(`^ABER_ENROLLMENT_TOKEN=${FIRST}$`, 'm'));
  assert.equal(at.enrolled(), false);
  at.alive(SECOND);
  at.reach(true);
  return at;
}

for (const running of [false, true]) {
  test(`a re-issued command enrols with its own token, with ${running ? 'a service left running' : 'nothing running'}`, { skip: SKIP }, () => {
    const at = reissued();
    at.running(running);
    const before = at.text();
    const { code, said } = at.run(SECOND);
    assert.equal(code, 0, said);
    assert.equal(at.enrolled(), true, said);
    // The first run redeemed the first token, and nothing after it did: not the playbook's own start.
    assert.deepEqual(at.redeemed(), [FIRST, SECOND]);
    assert.deepEqual(at.playbook(), ['none', SECOND]);
    // The token's line alone.
    assert.equal(at.text(), before.replace(FIRST, SECOND));
    assert.match(at.text(), /^NODERED_CREDENTIAL_SECRET=secret-1$/m);
    assert.equal(existsSync(`${at.env}.tmp`), false);
  });
}

test('it says so in one line, and prints neither token', { skip: SKIP }, () => {
  const at = reissued();
  const { said } = at.run(SECOND);
  const about = said.split('\n').filter((line) => line.includes('token'));
  assert.deepEqual(about, [`[aber-gateway-install] ${at.compose}/.env now holds this command's token; the rest of it is kept`]);
  for (const token of [FIRST, SECOND]) assert.equal(said.includes(token), false, 'the installer printed a token');
});

test('the same command again leaves the .env as it is', { skip: SKIP }, () => {
  const at = machine();
  at.alive(FIRST);
  at.reach(false);
  at.run(FIRST);
  const before = at.text();
  at.reach(true);
  const { code, said } = at.run(FIRST);
  assert.equal(code, 0, said);
  assert.equal(at.enrolled(), true, said);
  assert.equal(at.text(), before);
  assert.equal(said.includes("holds this command's token"), false, said);
  assert.match(said, /keeping the \.env already at/);
});

test('a command whose token the platform refuses changes nothing', { skip: SKIP }, () => {
  const at = reissued();
  const before = at.text();
  const { code } = at.run('c'.repeat(64));
  assert.notEqual(code, 0);
  assert.equal(at.text(), before);
});

test('an enrolled appliance is refused, and its .env is unchanged', { skip: SKIP }, () => {
  const at = machine();
  at.alive(FIRST);
  assert.equal(at.run(FIRST).code, 0);
  const before = at.text();
  at.alive(SECOND);
  const { code, said } = at.run(SECOND);
  assert.notEqual(code, 0, said);
  assert.match(said, /already enrolled/);
  assert.equal(at.text(), before);
  assert.deepEqual(at.redeemed(), [FIRST]);
});

test('an .env somebody edited keeps every other line, and is given the token it lacks', { skip: SKIP }, () => {
  const at = reissued();
  const edited = ['FLOW_SYNC_INTERVAL_SECONDS=60', `# ABER_ENROLLMENT_TOKEN=${FIRST}`, 'NODERED_CREDENTIAL_SECRET=kept', ''].join('\n');
  writeFileSync(at.env, edited);
  const { code, said } = at.run(SECOND);
  assert.equal(code, 0, said);
  assert.equal(at.text(), `${edited}ABER_ENROLLMENT_TOKEN=${SECOND}\n`);
});

test('the .env keeps its permissions', { skip: SKIP || (WINDOWS && 'Windows has no file modes') }, () => {
  for (const mode of [0o600, 0o640]) {
    const at = reissued();
    assert.equal(statSync(at.env).mode & 0o777, 0o600);
    chmodSync(at.env, mode);
    assert.equal(at.run(SECOND).code, 0);
    assert.equal(statSync(at.env).mode & 0o777, mode);
  }
});

const ADVICE = 'If the token was refused, re-issue the command from the dashboard; otherwise fix what it names and run the same command again.';
const NOT_SPENT = 'Fix that and run the same command again. This run has not spent its token.';
const PLAYBOOK = 'the platform playbook failed';
const CONTAINERS = "the appliance's containers did not all start";
const last = (said) => said.trimEnd().split('\n').at(-1);

/** A run that ended because enrolment failed: bootstrap's own reason, then what to do, and no token. */
function assertRefused({ code, said }, reason) {
  assert.notEqual(code, 0, said);
  assert.ok(said.includes(`[bootstrap] FAILED: ${reason}`), said);
  assert.ok(last(said).startsWith('[aber-gateway-install] FAILED: enrolment did not complete;'), said);
  assert.ok(last(said).endsWith(ADVICE), said);
  assert.ok(said.includes('[bootstrap] enrolling with <the token>'), said);
  for (const token of [FIRST, SECOND]) assert.equal(said.includes(token), false, 'the installer printed a token');
}

/** A run that ended before bootstrap started: that step's own reason, and nothing of bootstrap's. */
function assertNotStarted({ code, said }, reason, failed) {
  assert.notEqual(code, 0, said);
  assert.ok(said.includes(reason), said);
  assert.equal(last(said), `[aber-gateway-install] FAILED: ${failed}; what is printed above says why. ${NOT_SPENT}`);
  assert.equal(said.includes('[bootstrap]'), false, said);
}

test('a refused token ends with what bootstrap said and the advice', { skip: SKIP }, () => {
  const at = machine();
  at.alive(FIRST);
  at.set('spent');
  const ended = at.run(FIRST);
  assertRefused(ended, 'the enrolment token was refused.');
  assert.match(ended.said, /5\/5 enrolment/);
  assert.equal(at.enrolled(), false);
});

test('so does one that the playbook redeems, when it starts the project itself', { skip: SKIP }, () => {
  const at = reissued();
  at.set('spent');
  const ended = at.run(SECOND);
  assertRefused(ended, 'the enrolment token was refused.');
  assert.deepEqual(at.playbook(), ['none', SECOND]);
  assert.equal(ended.said.includes('4/5'), false, ended.said);
});

test('an enrolment that cannot reach the platform ends with the same advice', { skip: SKIP }, () => {
  const at = machine();
  at.alive(FIRST);
  at.reach(false);
  assertRefused(at.run(FIRST), 'the platform is unreachable.');
});

for (const [wrong, reason] of [['unpullable', 'pull access denied'], ['unmountable', 'failed to mount local volume']]) {
  test(`a project that cannot start (${wrong}) ends with its own reason`, { skip: SKIP }, () => {
    const at = machine();
    at.alive(FIRST);
    at.set(wrong);
    assertNotStarted(at.run(FIRST), reason, CONTAINERS);
    assert.deepEqual(at.redeemed(), []);
  });
}

// Bootstrap's container is there from the first run, with that run's log in it.
for (const running of [false, true]) {
  test(`and with nothing of an earlier refusal, with ${running ? 'a service left running' : 'nothing running'}`, { skip: SKIP }, () => {
    const at = reissued();
    at.running(running);
    at.set('unpullable');
    assertNotStarted(at.run(SECOND), 'pull access denied', running ? CONTAINERS : PLAYBOOK);
    assert.deepEqual(at.redeemed(), [FIRST]);
  });
}

test('a playbook that fails before it starts the project ends with its own reason', { skip: SKIP }, () => {
  for (const at of [machine(), reissued()]) {
    at.alive(SECOND);
    at.set('broken-playbook');
    assertNotStarted(at.run(SECOND), 'apt is locked', PLAYBOOK);
  }
});

test('an appliance that enrolled and did not start says so, and not to run the command again', { skip: SKIP }, () => {
  for (const [at, token, failed] of [[machine(), FIRST, CONTAINERS], [reissued(), SECOND, PLAYBOOK]]) {
    at.alive(token);
    at.set('port-taken');
    const { code, said } = at.run(token);
    assert.notEqual(code, 0, said);
    assert.equal(at.enrolled(), true);
    assert.ok(said.includes('port is already allocated'), said);
    assert.ok(said.includes(`[aber-gateway-install] FAILED: ${failed}, and this appliance has enrolled.`), said);
    assert.ok(said.includes(`sudo docker compose --project-directory ${at.compose} up -d --build`), said);
    for (const other of [ADVICE, NOT_SPENT, '[bootstrap]', 'the gateway shows ONLINE']) assert.equal(said.includes(other), false, other);
  }
});
