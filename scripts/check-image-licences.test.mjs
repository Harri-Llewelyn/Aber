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
  dockerfileBases, libraryProblems, licenceCopies, manifestProblems, mirrorProblems, namedContextProblems,
  noticeExtension, offerProblems, templateImages, unlisted, valuesImages,
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
    'FROM supabase/edge-runtime:v1.77.0 AS runtime',
    'FROM --platform=linux/amd64 runtime AS offline-check',
    'FROM ${BASE}',
    'FROM python:3.12-slim@sha256:' + 'a'.repeat(64),
    'FROM runtime',
  ].join('\n');
  assert.deepEqual(dockerfileBases(text), [
    'denoland/deno:2.1.4',
    'supabase/edge-runtime:v1.77.0',
    'ghcr.io/harri-llewelyn/aber/ingestion:1.7.0',
    `python:3.12-slim@sha256:${'a'.repeat(64)}`,
  ]);
  assert.deepEqual(dockerfileBases('ARG NOPE\nFROM ${NOPE}'), ['${NOPE}']);
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
  const RELEASE = 'https://github.com/Harri-Llewelyn/Aber/releases/tag/gpl-sources-supabase-postgres-17.6.1.175';
  const notice = [
    NOTICE_ROWS,
    'the [nixpkgs](https://github.com/NixOS/nixpkgs/tree/fb7944c166a3b630f177938e478f0378e64ce108) its `flake.lock` pins.',
    `[\`gpl-sources-supabase-postgres-17.6.1.175\`](${RELEASE}).`,
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
  const lock = (over = {}) => JSON.stringify({ base: 'supabase/postgres:17.6.1.175', assets: ASSETS, ...over });
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
    'licenses/supabase-postgres/pgrouting/SOURCE links the sources release for supabase/postgres:17.6.1.174, and the images build on 17.6.1.175',
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
