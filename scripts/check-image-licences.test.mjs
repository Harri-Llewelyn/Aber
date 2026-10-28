// scripts/check-image-licences.mjs: which images it reads from values, templates and Dockerfiles,
// which of them NOTICE.md must name, the SHA-256 pins on licenses/, and the builds that must hand a
// Dockerfile the `licenses` named context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dockerfileBases, licenceCopies, manifestProblems, namedContextProblems, templateImages, unlisted,
  valuesImages,
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

test('the repository passes the check as it stands', () => {
  const run = spawnSync(process.execPath, [join(REPO, 'scripts/check-image-licences.mjs')], { cwd: REPO, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
