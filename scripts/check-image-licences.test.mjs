// scripts/check-image-licences.mjs: which images it reads from values, templates and Dockerfiles,
// which of them NOTICE.md must name, the SHA-256 pins on licenses/, the builds that must hand a
// Dockerfile the `licenses` named context, and the written offers of the GPL extensions' source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dockerfileBases, extensionTextProblems, finalStage, floatingBases, isAlpine, isPermissiveRow, isPinned,
  libraryProblems, licenceCopies, manifestProblems, matrixContexts, mirrorProblems, namedContextProblems,
  noticeExtension, noticeExtensionRows, offerProblems, osPackageProblems, publishedDockerfiles, templateImages,
  unlisted, valuesImages,
} from './check-image-licences.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (text) => createHash('sha256').update(text).digest('hex');

const VALUES = `loki:
  image:
    repository: grafana/loki
    # A version, not a floating tag.
    tag: "3.7.8"
    pullPolicy: IfNotPresent
frontend:
  image:
    repository: ghcr.io/harri-llewelyn/aber/frontend
    tag: ""
jobs:
  curlImage:
    repository: curlimages/curl
    tag: '8.22.0'
  storageInitImage:
    repository: node
    tag: 24.21.0-alpine3.24 # pinned
`;

test('values.yaml: each repository with the tag beside it, and an empty tag is an image built here', () => {
  assert.deepEqual(valuesImages(VALUES).map(({ image, built }) => [image, built]), [
    ['grafana/loki:3.7.8', false],
    ['ghcr.io/harri-llewelyn/aber/frontend', true],
    ['curlimages/curl:8.22.0', false],
    ['node:24.21.0-alpine3.24', false],
  ]);
});

test('a template names an image only on a literal image: line, never one it renders', () => {
  const text = [
    '      initContainers:',
    '        - name: wait',
    '          image: alpine:3.24',
    '          image: {{ include "aber.image" .Values.mosquitto.image }}',
    '          image: "{{ .Values.jobs.curlImage.repository }}:{{ .Values.jobs.curlImage.tag }}"',
    '          # The suite\'s own image: its Python reads the Job.',
  ].join('\n');
  assert.deepEqual(templateImages(text).map((i) => i.image), ['alpine:3.24']);
});

test('a Dockerfile names its FROM images, not the stages it built, with ARG defaults filled in', () => {
  const text = [
    'ARG BASE=ghcr.io/harri-llewelyn/aber/ingestion:1.7.0',
    'FROM denoland/deno:2.1.4 AS modules',
    'FROM supabase/edge-runtime:v1.77.4 AS runtime',
    'FROM --platform=linux/amd64 runtime AS offline-check',
    'FROM ${BASE}',
    'FROM python:3.12-slim@sha256:' + 'a'.repeat(64),
    'FROM runtime',
  ].join('\n');
  assert.deepEqual(dockerfileBases(text), [
    'denoland/deno:2.1.4',
    'supabase/edge-runtime:v1.77.4',
    'ghcr.io/harri-llewelyn/aber/ingestion:1.7.0',
    `python:3.12-slim@sha256:${'a'.repeat(64)}`,
  ]);
  assert.deepEqual(dockerfileBases('ARG NOPE\nFROM ${NOPE}'), ['${NOPE}']);
});

test('a base is pinned by a full version or a digest; a floating one fails unless held, and a stale hold fails', () => {
  for (const ref of ['supabase/postgres:17.6.1.175', 'timescale/timescaledb:2.31.0-pg17', 'nginx:1.31.9-alpine3.24',
    'swaggerapi/swagger-ui:v5.34.1', `python:3.12-slim@sha256:${'c'.repeat(64)}`, 'localhost:5000/x:1.2.3']) {
    assert.equal(isPinned(ref), true, ref);
  }
  for (const ref of ['nginx:alpine', 'node:24-alpine', 'node:24.22-alpine3.24', 'python:3.13-slim', 'alpine:latest', 'alpine', 'localhost:5000/x']) {
    assert.equal(isPinned(ref), false, ref);
  }
  const dockerfiles = [
    { path: 'frontend/Dockerfile', text: 'FROM node:24-alpine AS builder\nFROM nginx:alpine\n' },
    { path: 'i3x/Dockerfile', text: 'FROM python:3.13-slim\n' },
    { path: 'test-harness/Dockerfile', text: 'ARG BASE=ghcr.io/harri-llewelyn/aber/ingestion:1.8.0\nFROM ${BASE}\n' },
  ];
  assert.deepEqual(floatingBases(dockerfiles, new Set(['python:3.13-slim', 'python:3.12-slim'])), [
    'frontend/Dockerfile: FROM node:24-alpine floats; pin it to a version (x.y.z), as every other base is',
    'frontend/Dockerfile: FROM nginx:alpine floats; pin it to a version (x.y.z), as every other base is',
    'FLOATING_HELD holds python:3.12-slim, which no Dockerfile names any more',
  ]);
});

test("an image NOTICE.md does not name fails, as main's NOTICE.md failed for Loki; a digest is not needed", () => {
  const pinned = [
    { image: 'grafana/grafana:13.2.3', at: 'values.yaml' },
    { image: 'grafana/loki:3.7.8', at: 'values.yaml' },
    { image: `python:3.12-slim@sha256:${'b'.repeat(64)}`, at: 'forge/Dockerfile' },
  ];
  const notice = '| `grafana/grafana:13.2.3` | AGPL-3.0 |\n| `python:3.12-slim` | PSF |\n';
  assert.deepEqual(unlisted(pinned, notice).map((p) => p.image), ['grafana/loki:3.7.8']);
  // Named in prose without backticks is not a listing.
  assert.deepEqual(unlisted([{ image: 'grafana/loki:3.7.8' }], 'Loki is grafana/loki:3.7.8.').length, 1);
});

test('licenses/ must hold exactly the files SHA256SUMS pins, each at its SHA-256', () => {
  const dir = mkdtempSync(join(tmpdir(), 'licences-'));
  try {
    mkdirSync(join(dir, 'set/component'), { recursive: true });
    writeFileSync(join(dir, 'set/component/LICENSE'), 'licence text\n');
    writeFileSync(join(dir, 'README.md'), '# not pinned, the folder\'s own\n');
    writeFileSync(join(dir, 'SHA256SUMS'), `${sha('licence text\n')}  set/component/LICENSE\n`);
    assert.deepEqual(manifestProblems(dir).problems, []);

    writeFileSync(join(dir, 'set/component/LICENSE'), 'licence text, edited\n');
    writeFileSync(join(dir, 'set/component/NOTICE'), 'unpinned\n');
    writeFileSync(join(dir, 'SHA256SUMS'), `${sha('licence text\n')}  set/component/LICENSE\n${sha('x')}  set/gone\nnot a line\n`);
    const { problems } = manifestProblems(dir);
    assert.equal(problems.length, 4, problems.join('\n'));
    assert.match(problems.join('\n'), /SHA256SUMS:3 is not/);
    assert.match(problems.join('\n'), /set\/component\/NOTICE is not pinned/);
    assert.match(problems.join('\n'), /set\/gone, which does not exist/);
    assert.match(problems.join('\n'), /set\/component\/LICENSE is sha256:[0-9a-f]{64}, pinned to/);

    writeFileSync(join(dir, 'SHA256SUMS'), `${sha('x')}  ../outside\n`);
    assert.match(manifestProblems(dir).problems.join('\n'), /SHA256SUMS:1 is not/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Dockerfile copies a licence set through the named context or from the repository root', () => {
  const text = [
    'COPY --from=licenses timescaledb/ /usr/share/licenses/',
    'COPY licenses/swagger-ui/ /usr/share/licenses/',
    'COPY --from=modules /deno-dir/npm /home/deno/deno-dir/npm',
    'COPY docs/openapi.yaml /usr/share/nginx/html/',
  ].join('\n');
  assert.deepEqual(licenceCopies(text), [{ named: true, set: 'timescaledb' }, { named: false, set: 'swagger-ui' }]);
});

const ALPINE = (lines) => ['FROM node:24.22.3-alpine3.24 AS builder', 'RUN npm ci', 'FROM nginx:1.31.9-alpine3.24', ...lines].join('\n');
const WRITES = ['RUN apk upgrade --no-cache', 'COPY --from=licenses os-packages.sh /tmp/os-packages.sh', 'RUN sh /tmp/os-packages.sh && rm /tmp/os-packages.sh'];

test('a final stage is followed through earlier stages, and is Alpine by its tag, its base or its apk', () => {
  const stage = finalStage('ARG V=1.77.4\nFROM supabase/edge-runtime:v${V} AS runtime\nRUN true\nFROM runtime\nUSER 1000\n');
  assert.deepEqual(stage, { base: 'supabase/edge-runtime:v1.77.4', lines: ['USER 1000'] });
  assert.equal(isAlpine(stage), false);
  assert.equal(isAlpine(finalStage('FROM eclipse-mosquitto:2.1.2-alpine\n')), true);
  assert.equal(isAlpine(finalStage('FROM supabase/postgres:17.6.1.175\n')), true);
  assert.equal(isAlpine(finalStage('FROM example/base:1.0.0\nRUN apk add --no-cache curl\n')), true);
  assert.equal(isAlpine(finalStage('FROM python:3.13-slim\nRUN apt-get install -y curl\n')), false);
  assert.deepEqual(publishedDockerfiles(WORKFLOW), ['timescaledb/Dockerfile']);
});

test('a published Alpine image copies os-packages.sh and runs it as root after its last apk step', () => {
  assert.deepEqual(osPackageProblems([
    { path: 'frontend/Dockerfile', text: ALPINE([...WRITES, 'USER 101:101']) },
    { path: 'node-red/Dockerfile', text: ['FROM nodered/node-red:5.0.9', 'USER root', ...WRITES, 'USER node-red', 'RUN npm install x'].join('\n') },
    { path: 'gateway-credential/Dockerfile', text: 'FROM eclipse-mosquitto:2.1.2-alpine\nRUN apk add nodejs\nCOPY licenses/os-packages.sh /tmp/\nRUN sh /tmp/os-packages.sh\n' },
    { path: 'i3x/Dockerfile', text: 'FROM python:3.13-slim\nRUN pip install x\n' },
  ]), []);

  assert.deepEqual(osPackageProblems([
    { path: 'a/Dockerfile', text: ALPINE(['RUN apk upgrade --no-cache']) },
    { path: 'b/Dockerfile', text: ALPINE([...WRITES, 'RUN apk add --no-cache curl']) },
    { path: 'c/Dockerfile', text: ALPINE(['USER 101', ...WRITES.slice(1)]) },
    { path: 'd/Dockerfile', text: ALPINE([WRITES[1], 'RUN sh /tmp/os-packages.sh && apk add jq']) },
  ]), [
    "a/Dockerfile's final stage is Alpine and does not copy licenses/os-packages.sh, so its image carries no list of its OS packages' licences",
    "a/Dockerfile's final stage is Alpine and never runs os-packages.sh, so its image carries no list of its OS packages' licences",
    'b/Dockerfile changes its packages with apk after running os-packages.sh: "RUN apk add --no-cache curl"',
    'c/Dockerfile runs os-packages.sh as 101; it writes /usr/share/licenses/ and must run as root',
    'd/Dockerfile changes its packages with apk after os-packages.sh in one RUN, so the list is not what the image ships',
  ]);
});

const WORKFLOW = `jobs:
  build-images:
    strategy:
      matrix:
        include:
          - name: timescaledb
            dockerfile: timescaledb/Dockerfile
            context: timescaledb
            build_contexts: licenses=./licenses
    steps:
      - name: Build
        uses: docker/build-push-action@0000000000000000000000000000000000000000 # v7
        with:
          file: \${{ matrix.dockerfile }}
          build-contexts: \${{ matrix.build_contexts }}
`;
const DEV = "  { name: 'timescaledb', file: 'timescaledb/Dockerfile', context: 'timescaledb', contexts: ['licenses=./licenses'] },\n";
const DOC = 'docker build -f timescaledb/Dockerfile --build-context licenses=./licenses \\\n    -t $NS/timescaledb:$V timescaledb\n';

test('every build of a Dockerfile that copies from the named context hands it the context', () => {
  const sites = (over = {}) => ({
    workflows: [{ path: 'release.yml', text: WORKFLOW }],
    devCluster: DEV,
    texts: [{ path: 'README.md', text: DOC }],
    bake: '',
    ...over,
  });
  assert.deepEqual(namedContextProblems('timescaledb/Dockerfile', sites()), []);

  const problems = namedContextProblems('timescaledb/Dockerfile', sites({
    workflows: [{ path: 'release.yml', text: WORKFLOW.replace('            build_contexts: licenses=./licenses\n', '').replace('          build-contexts: ${{ matrix.build_contexts }}\n', '') }],
    devCluster: DEV.replace(", contexts: ['licenses=./licenses']", ''),
    texts: [{ path: 'README.md', text: 'docker build -f timescaledb/Dockerfile -t x timescaledb\n' }],
    bake: 'target "historian" { dockerfile = "timescaledb/Dockerfile" }',
  }));
  assert.deepEqual(problems, [
    "release.yml's matrix entry for timescaledb/Dockerfile passes no licenses=./licenses in build_contexts",
    'release.yml: the step "Build" does not pass its matrix entry\'s build_contexts',
    "scripts/dev-cluster.mjs's IMAGES entry for timescaledb/Dockerfile names no 'licenses=./licenses' in contexts",
    'README.md:1 builds timescaledb/Dockerfile without --build-context licenses=./licenses',
    'docker-bake.hcl builds timescaledb/Dockerfile with no "licenses" context',
  ]);
});

test('a matrix entry passes its contexts one per line; a comma does not separate two', () => {
  const block = (value) => `          - name: frontend\n            dockerfile: frontend/Dockerfile\n            build_contexts: ${value}\n    steps:\n`;
  assert.deepEqual(matrixContexts(block('|\n              help=./help\n              licenses=./licenses')), ['help=./help', 'licenses=./licenses']);
  assert.deepEqual(matrixContexts(block('licenses=./licenses')), ['licenses=./licenses']);
  assert.deepEqual(matrixContexts(block('help=./help,licenses=./licenses')), ['help=./help,licenses=./licenses']);
  assert.deepEqual(matrixContexts('          - name: edge-runtime\n            dockerfile: x\n'), []);

  const workflow = WORKFLOW.replace('build_contexts: licenses=./licenses', 'build_contexts: help=./help,licenses=./licenses');
  assert.match(namedContextProblems('timescaledb/Dockerfile', { workflows: [{ path: 'release.yml', text: workflow }], devCluster: DEV, texts: [], bake: '' })[0],
    /passes no licenses=\.\/licenses in build_contexts/);
});

const NOTICE_ROWS = [
  '| Extension | Version | Licence | Project |',
  '| `postgis`, `postgis_raster` | 3.3.7 | **GPL-2.0-or-later** | [`postgis/postgis`](https://github.com/postgis/postgis) `3.3.7` |',
  '| `address_standardizer` | 3.3.7 | MIT | [`postgis/postgis`](https://github.com/postgis/postgis) `3.3.7`, `extensions/address_standardizer` |',
  '| `pgrouting` | 3.4.1 | **GPL-2.0-or-later** | [`pgRouting/pgrouting`](https://github.com/pgRouting/pgrouting) `v3.4.1` |',
].join('\n');
const OFFER = {
  'supabase-postgres/postgis/SOURCE':
    'PostGIS 3.3.7, unmodified from supabase/postgres:17.6.1.175.\nhttps://github.com/postgis/postgis/tree/3.3.7\n',
  'supabase-postgres/pgrouting/SOURCE':
    'pgRouting 3.4.1, unmodified from supabase/postgres:17.6.1.175.\nhttps://github.com/pgRouting/pgrouting/tree/v3.4.1\n',
};
const ON_BASE = [
  { path: 'supabase/db/Dockerfile', text: 'FROM supabase/postgres:17.6.1.175\nCOPY --from=licenses supabase-postgres/ /usr/share/licenses/\n' },
  { path: 'backup-service/Dockerfile', text: 'FROM supabase/postgres:17.6.1.175\nCOPY licenses/supabase-postgres/ /usr/share/licenses/\n' },
  { path: 'frontend/Dockerfile', text: 'FROM nginx:alpine\n' },
];

test("NOTICE.md's extension row gives the version and the repository's tag", () => {
  assert.deepEqual(noticeExtension(NOTICE_ROWS, 'pgrouting'), { version: '3.4.1', repo: 'https://github.com/pgRouting/pgrouting', tag: 'v3.4.1' });
  assert.deepEqual(noticeExtension(NOTICE_ROWS, 'postgis'), { version: '3.3.7', repo: 'https://github.com/postgis/postgis', tag: '3.3.7' });
  assert.equal(noticeExtension(NOTICE_ROWS, 'postgis_raster'), null);
});

const EXTENSION_TABLE = [
  '| Extension or library | Version | Licence | Project |',
  '| :--- | :--- | :--- | :--- |',
  '| PostgreSQL\'s own: `amcheck`, `bloom` | 17.6 | PostgreSQL License | [`postgres/postgres`](https://github.com/postgres/postgres) `REL_17_6` |',
  NOTICE_ROWS.split('\n').slice(1).join('\n'),
  '| `pg_cron` | 1.6.4 | PostgreSQL License | [`citusdata/pg_cron`](https://github.com/citusdata/pg_cron) `v1.6.4` |',
  '| `pgjwt` | 0.2.0 | MIT | [`michelp/pgjwt`](https://github.com/michelp/pgjwt) commit `f3d82fd30151e754e19ce5d6a06c71c20689ce3d` |',
  '| `plan_filter`, a server library | 0.1 | PostgreSQL License | [`pgexperts/pg_plan_filter`](https://github.com/pgexperts/pg_plan_filter) commit `5081a7b` |',
  '',
  '| Library | Version | Licence | Source |',
  '| Boost (`serialization`) | 1.87.0 | BSL-1.0 | [`boostorg/boost`](https://github.com/boostorg/boost) `boost-1.87.0` |',
].join('\n');

test("NOTICE.md's extension table gives each row's names and the ref its licence was read at, and stops at the table", () => {
  const rows = noticeExtensionRows(EXTENSION_TABLE);
  assert.deepEqual(rows.map((r) => [r.names[0], r.ref, isPermissiveRow(r)]), [
    ['amcheck', 'REL_17_6', false],
    ['postgis', '3.3.7', false],
    ['address_standardizer', '3.3.7', true],
    ['pgrouting', 'v3.4.1', false],
    ['pg_cron', 'v1.6.4', true],
    ['pgjwt', 'f3d82fd30151e754e19ce5d6a06c71c20689ce3d', true],
    ['plan_filter', '5081a7b', true],
  ]);
  assert.deepEqual(noticeExtensionRows('| Extension | Version | Licence | Project |\n'), []);
});

test('each permissive extension NOTICE.md lists has a pinned text, named in licenses/README.md at its ref', () => {
  const pinned = new Map(['address_standardizer/COPYING', 'pg_cron/LICENSE', 'pgjwt/LICENSE', 'plan_filter/License']
    .map((f) => [`supabase-postgres/${f}`, 'x']));
  const readme = [
    '| `supabase-postgres/address_standardizer/COPYING` | [`postgis/postgis`](https://github.com/postgis/postgis) `3.3.7` |',
    '| `supabase-postgres/pg_cron/LICENSE` | [`citusdata/pg_cron`](https://github.com/citusdata/pg_cron) `v1.6.4` |',
    '| `supabase-postgres/pgjwt/LICENSE` | commit `f3d82fd30151e754e19ce5d6a06c71c20689ce3d` |',
    '| `supabase-postgres/plan_filter/License` | commit `5081a7b` |',
  ].join('\n');
  assert.deepEqual(extensionTextProblems(EXTENSION_TABLE, pinned, readme), []);

  pinned.delete('supabase-postgres/pg_cron/LICENSE');
  assert.deepEqual(extensionTextProblems(EXTENSION_TABLE, pinned, readme.replace('`v1.6.4`', '').replace('commit `5081a7b`', '`main`').split('\n').slice(0, 3).join('\n')), [
    'NOTICE.md lists pg_cron (https://github.com/citusdata/pg_cron v1.6.4), and licenses/supabase-postgres/pg_cron/ holds no pinned licence text for it',
    'licenses/README.md does not name licenses/supabase-postgres/plan_filter/',
  ]);
  assert.deepEqual(extensionTextProblems(EXTENSION_TABLE, new Map([...pinned, ['supabase-postgres/pg_cron/LICENSE', 'x']]), readme.replace('`v1.6.4`', '`v1.6.3`')), [
    'licenses/README.md names licenses/supabase-postgres/pg_cron/ without v1.6.4, the ref NOTICE.md says its text was read at',
  ]);
  assert.match(extensionTextProblems('no table', pinned, readme)[0], /the parse has stopped matching it/);
});

test('every image built on supabase/postgres carries a pinned written offer naming its base and versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offers-'));
  const write = (offers) => {
    for (const [file, text] of Object.entries(offers)) {
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
  };
  const allPinned = new Map(Object.keys(OFFER).map((f) => [f, 'x']));
  try {
    write(OFFER);
    assert.deepEqual(offerProblems(dir, allPinned, NOTICE_ROWS, ON_BASE), []);

    // An unpinned offer, and an image on the base that does not copy the set.
    const problems = offerProblems(dir, new Map([['supabase-postgres/postgis/SOURCE', 'x']]), NOTICE_ROWS, [
      ...ON_BASE, { path: 'supabase/db-init/Dockerfile', text: 'FROM supabase/postgres:17.6.1.175\nCOPY migrations/*.sql /migrations/\n' },
    ]);
    assert.deepEqual(problems, [
      'supabase/db-init/Dockerfile builds on supabase/postgres and does not copy licenses/supabase-postgres/, so its image carries no supabase-postgres/postgis/SOURCE',
      'licenses/supabase-postgres/pgrouting/SOURCE, the written offer of pgrouting\'s source, is not pinned in licenses/SHA256SUMS',
      'supabase/db-init/Dockerfile builds on supabase/postgres and does not copy licenses/supabase-postgres/, so its image carries no supabase-postgres/pgrouting/SOURCE',
    ]);

    // A wrong version of the extension, and of the base.
    write({ 'supabase-postgres/postgis/SOURCE': 'PostGIS 3.3.6, unmodified from supabase/postgres:17.6.1.174.\nhttps://github.com/postgis/postgis/tree/3.3.6\n' });
    assert.deepEqual(offerProblems(dir, allPinned, NOTICE_ROWS, ON_BASE), [
      'licenses/supabase-postgres/postgis/SOURCE does not name supabase/postgres:17.6.1.175, the base its images are built on',
      'licenses/supabase-postgres/postgis/SOURCE names supabase/postgres:17.6.1.174, which no image builds on',
      'licenses/supabase-postgres/postgis/SOURCE does not link https://github.com/postgis/postgis/tree/3.3.7, the postgis NOTICE.md says the image ships',
      'licenses/supabase-postgres/postgis/SOURCE links postgis at 3.3.6, not 3.3.7',
      'licenses/supabase-postgres/postgis/SOURCE does not name postgis 3.3.7',
    ]);
    // The images moved to a new base, and the offer still names the old one.
    const moved = ON_BASE.map((d) => ({ ...d, text: d.text.replace('17.6.1.175', '17.6.1.176') }));
    write(OFFER);
    assert.match(offerProblems(dir, allPinned, NOTICE_ROWS, moved).join('\n'), /does not name supabase\/postgres:17\.6\.1\.176/);

    // A missing offer.
    rmSync(join(dir, 'supabase-postgres/pgrouting/SOURCE'));
    assert.deepEqual(offerProblems(dir, allPinned, NOTICE_ROWS, ON_BASE), [
      "licenses/supabase-postgres/pgrouting/SOURCE does not exist, so the images built on supabase/postgres carry no written offer of pgrouting's source",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each copyleft library NOTICE.md lists is in the PostGIS offer at its version, with its licence folder', () => {
  const notice = [
    '**The libraries only PostGIS loads.** They are read from the image.',
    '',
    '| Library | Version | Licence | Source |',
    '| :--- | :--- | :--- | :--- |',
    '| GEOS | 3.14.1 | **LGPL-2.1** | x |',
    '| CGAL, compiled into SFCGAL | 6.1 | **GPL-3.0-or-later** | x |',
    '| PROJ | 9.7.1 | MIT | x |',
    '',
    '| Not | this | table | GPL |',
  ].join('\n');
  const own = ['postgis', 'pgrouting'];
  assert.deepEqual(libraryProblems(notice, '- GEOS 3.14.1, LGPL\n- CGAL 6.1, compiled in\n', ['postgis', 'pgrouting', 'geos', 'cgal'], own), []);
  assert.deepEqual(libraryProblems(notice, '- GEOS 3.14.10\n- CGAL 6.1\n', ['postgis', 'geos', 'gdal'], own), [
    'licenses/supabase-postgres/postgis/SOURCE does not name GEOS 3.14.1, which NOTICE.md lists',
    'NOTICE.md lists CGAL, and licenses/supabase-postgres/cgal/ holds no licence text for it',
    'licenses/supabase-postgres/gdal/ is no copyleft library NOTICE.md lists', // a made-up folder, gone from the tree
  ]);
  assert.match(libraryProblems('no table here', '', [], own)[0], /the parse has stopped matching it/);
});

test('the offers link the sources release for the base, and the lock holds every component at its version', () => {
  const RELEASE = 'https://github.com/Harri-Llewelyn/Aber/releases/tag/gpl-sources-supabase-postgres-17.6.1.175-postgis';
  const notice = [
    NOTICE_ROWS,
    'the [nixpkgs](https://github.com/NixOS/nixpkgs/tree/fb7944c166a3b630f177938e478f0378e64ce108) its `flake.lock` pins.',
    `[\`gpl-sources-supabase-postgres-17.6.1.175-postgis\`](${RELEASE}).`,
    '',
    '**The libraries only PostGIS loads.** Read from the image.',
    '',
    '| Library | Version | Licence | Source |',
    '| :--- | :--- | :--- | :--- |',
    '| GEOS | 3.14.1 | **LGPL-2.1** | x |',
    '| PROJ | 9.7.1 | MIT | x |',
  ].join('\n');
  const entry = (component, version, name) => ({
    component, version, url: `https://example.invalid/${name}`, asset: name, sha256: 'a'.repeat(64), size: 1,
  });
  const ASSETS = [
    entry('PostGIS', '3.3.7', 'postgis-3.3.7.tar.gz'),
    entry('pgRouting', '3.4.1', 'pgrouting-3.4.1.tar.gz'),
    entry('pgRouting', '3.4.1', 'pgrouting-3.4.1-pg17.patch'),
    entry('GEOS', '3.14.1', 'geos-3.14.1.tar.bz2'),
    entry('supabase/postgres', '17.6.1.175', 'supabase-postgres-17.6.1.175.tar.gz'),
    entry('nixpkgs', 'fb7944c166a3b630f177938e478f0378e64ce108', 'nixpkgs.tar.xz'),
  ];
  const lock = (over = {}) => JSON.stringify({ base: 'supabase/postgres:17.6.1.175', scope: 'postgis', assets: ASSETS, ...over });
  const offers = [
    { path: 'licenses/supabase-postgres/postgis/SOURCE', text: `Download it from\n${RELEASE}\n` },
    { path: 'NOTICE.md', text: notice },
  ];
  assert.deepEqual(mirrorProblems(lock(), notice, offers, ['17.6.1.175']), []);

  // An offer without the release, one linking another base's, and a lock pinned to another base.
  assert.deepEqual(mirrorProblems(lock({ base: 'supabase/postgres:17.6.1.174' }), notice, [
    { path: 'licenses/supabase-postgres/postgis/SOURCE', text: 'No link here.\n' },
    { path: 'licenses/supabase-postgres/pgrouting/SOURCE', text: `${RELEASE.replace('175', '174')}\n` },
  ], ['17.6.1.175']), [
    `licenses/supabase-postgres/postgis/SOURCE does not link ${RELEASE}, the source mirrored for the images' base`,
    `licenses/supabase-postgres/pgrouting/SOURCE does not link ${RELEASE}, the source mirrored for the images' base`,
    'licenses/supabase-postgres/pgrouting/SOURCE links https://github.com/Harri-Llewelyn/Aber/releases/tag/gpl-sources-supabase-postgres-17.6.1.174-postgis, not the release for supabase/postgres:17.6.1.175 and the scope postgis',
    'licenses/supabase-postgres/sources.json is for the base supabase/postgres:17.6.1.174, and the images build on 17.6.1.175',
  ]);

  // A component missing, one at the wrong version, and one NOTICE.md does not name.
  const changed = [...ASSETS.filter((a) => a.component !== 'GEOS'), entry('GDAL', '3.8.5', 'gdal.tar.gz')];
  changed[0] = { ...changed[0], version: '3.3.6' };
  assert.deepEqual(mirrorProblems(lock({ assets: changed }), notice, offers, ['17.6.1.175']), [
    'licenses/supabase-postgres/sources.json holds PostGIS 3.3.6 (postgis-3.3.7.tar.gz), and the images ship 3.3.7',
    'licenses/supabase-postgres/sources.json holds no archive of GEOS 3.14.1',
    'licenses/supabase-postgres/sources.json holds GDAL (gdal.tar.gz), which is no component NOTICE.md names',
  ]);
  assert.match(mirrorProblems('{"base": 1}', notice, offers, ['17.6.1.175']).join('\n'), /"base" is not/);
  assert.match(mirrorProblems(lock(), notice, offers, ['1', '2'])[0], /build on 2 supabase\/postgres tags/);
});

test('the repository passes the check as it stands', () => {
  const run = spawnSync(process.execPath, [join(REPO, 'scripts/check-image-licences.mjs')], { cwd: REPO, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
