import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Uploading a capture through the API layer. A file is checked against the rules playback applies
 * before anything is sent; the server decides the replace and issues the path before the file is
 * written; the row is repointed by register; and only then is the replaced file deleted. A refused
 * register deletes the file it would have stored, so the stored capture is never touched.
 */

const calls = vi.hoisted(() => ({ log: [], answers: {} }));

vi.mock('../lib/supabaseClient', () => {
  const answer = (name) => {
    const queue = calls.answers[name] || [{ data: null, error: null }];
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  const bucket = {
    upload: vi.fn((path, file, options) => {
      calls.log.push(['upload', path, options]);
      return Promise.resolve(answer('upload'));
    }),
    remove: vi.fn((paths) => {
      calls.log.push(['remove', paths]);
      return Promise.resolve({ data: [], error: null });
    })
  };
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: {
      rpc: vi.fn((name, args) => {
        calls.log.push(['rpc', name, args]);
        return Promise.resolve(answer(name));
      }),
      storage: { from: vi.fn(() => bucket) },
      auth: { getSession: vi.fn() }
    }
  };
});

import { api, captureFileProblem, captureManifest, isMachineMetric } from '../api';

const GOOD = {
  aber_capture_version: 1,
  capture_epoch_ms: 1700000000000,
  messages: [
    { offset_ms: 0, topic: 'spBv1.0/Aber/NBIRTH/gwy120000000000400080000', payload: { metrics: [] } },
    { offset_ms: 5, topic: 'spBv1.0/Aber/DDATA/gwy120000000000400080000/dev270000000000400080000',
      encoding: 'protobuf', payload: { metrics: [{ name: 'T', double_value: 1 }] } }
  ]
};

const withMessage = (i, change) => {
  const doc = JSON.parse(JSON.stringify(GOOD));
  doc.messages[i] = typeof change === 'function' ? change(doc.messages[i]) : change;
  return doc;
};

const file = (doc) => new File([JSON.stringify(doc)], 'line1.json', { type: 'application/json' });

const ISSUED = {
  upload_id: 'up-1',
  storage_path: 'gwy120000000000400080000/up-1.json',
  replaces_capture_id: 'cap-old',
  replaces_storage_path: 'gwy120000000000400080000/capture.json'
};

beforeEach(() => {
  calls.log.length = 0;
  calls.answers = {
    begin_capture_upload: [{ data: ISSUED, error: null }],
    upload: [{ data: { path: ISSUED.storage_path }, error: null }],
    register_uploaded_capture: [{ data: 'cap-new', error: null }]
  };
});

describe('the rules a capture file is checked against (shared with plan_playback)', () => {
  it('accepts a well-formed file', () => {
    expect(captureFileProblem(GOOD)).toBeNull();
  });

  it('checks the document: an object, the version this stack reads, an epoch, some messages', () => {
    expect(captureFileProblem([])).toMatch(/Node-RED flow export/);
    expect(captureFileProblem('x')).toMatch(/JSON object/);
    expect(captureFileProblem({ ...GOOD, aber_capture_version: undefined })).toMatch(/no aber_capture_version/);
    expect(captureFileProblem({ ...GOOD, aber_capture_version: 2 })).toMatch(/version 2/);
    expect(captureFileProblem({ ...GOOD, capture_epoch_ms: '1700000000000' })).toMatch(/capture_epoch_ms/);
    expect(captureFileProblem({ ...GOOD, messages: [] })).toMatch(/no messages/);
    expect(captureFileProblem({ ...GOOD, messages: 'abc' })).toMatch(/no messages/);
  });

  it('names a malformed message by its index', () => {
    const cases = [
      [withMessage(1, 'x'), /^message 1: is not an object$/],
      [withMessage(1, m => ({ ...m, topic: undefined })), /^message 1: has no topic$/],
      [withMessage(1, m => ({ ...m, payload: [] })), /^message 1: has no payload object$/],
      [withMessage(1, m => ({ ...m, offset_ms: 1.5 })), /^message 1: offset_ms is not a whole number$/],
      [withMessage(0, m => ({ ...m, offset_ms: -1 })), /^message 0: offset_ms is negative$/],
      [withMessage(1, m => ({ ...m, offset_ms: 86400001 })), /^message 1: offset_ms is more than 24 hours/],
      [withMessage(1, m => ({ ...m, payload: { metrics: { name: 'T' } } })), /^message 1: payload\.metrics is not a list/],
      [withMessage(1, m => ({ ...m, payload: { metrics: ['T'] } })), /^message 1: payload\.metrics is not a list/],
      [withMessage(1, m => ({ ...m, encoding: 'xml' })), /^message 1: encoding "xml" is not one/]
    ];
    for (const [doc, expected] of cases) expect(captureFileProblem(doc)).toMatch(expected);
  });

  it('refuses offsets that go back in time', () => {
    const doc = withMessage(0, m => ({ ...m, offset_ms: 10 }));
    expect(captureFileProblem(doc)).toBe('message 1: offset_ms 5 is earlier than the message before it (10)');
  });

  it('accepts only an edge node topic, with the device segment its type needs', () => {
    const topic = (t) => captureFileProblem(withMessage(1, m => ({ ...m, topic: t })));
    expect(topic('spBv1.0/Aber/NCMD/gwy1')).toMatch(/^message 1: message type "NCMD" is not one an edge node publishes$/);
    expect(topic('spBv1.0/STATE/host')).toMatch(/is not spBv1.0\/<group>/);
    expect(topic('spAv1.0/Aber/NDATA/gwy1')).toMatch(/is not spBv1.0\/<group>/);
    expect(topic('spBv1.0/Aber/DDATA/gwy1')).toMatch(/a DDATA topic needs a device segment/);
    expect(topic('spBv1.0/Aber/NDATA/gwy1/dev1')).toMatch(/an NDATA topic takes no device segment/);
    expect(topic('spBv1.0/Aber/DDATA/gwy1/dev1/extra')).toMatch(/is not spBv1.0\/<group>/);
    for (const bad of ['spBv1.0//NDATA/gwy1', 'spBv1.0/Aber/NDATA/gw+1', 'spBv1.0/Aber/NDATA/gw#',
      'spBv1.0/Aber/NDATA/gw\u00001']) {
      expect(topic(bad)).toMatch(/empty segment or one holding/);
    }
    for (const type of ['NBIRTH', 'NDEATH', 'NDATA']) expect(topic(`spBv1.0/Aber/${type}/gwy1`)).toBeNull();
    for (const type of ['DBIRTH', 'DDEATH', 'DDATA']) expect(topic(`spBv1.0/Aber/${type}/gwy1/dev1`)).toBeNull();
  });
});

describe('the metrics a capture lists', () => {
  it('leaves out Sparkplug plumbing and identity, and keeps Properties', () => {
    const names = ['bdSeq', 'Node Control/Rebirth', 'Device Control/Rebirth', 'Asset_ID', 'Asset_Name',
      'Instance_UUID', 'Schema_UUID', 'Properties/Serial', 'Temperature'];
    expect(names.filter(isMachineMetric)).toEqual(['Properties/Serial', 'Temperature']);
    const doc = withMessage(0, m => ({ ...m, payload: { metrics: names.map(name => ({ name })) } }));
    expect(captureManifest(doc).metric_names).toEqual(['Properties/Serial', 'Temperature', 'T']);
  });

  it('records how long the file spans', () => {
    expect(captureManifest(GOOD).duration_ms).toBe(5);
  });
});

describe('uploading a capture', () => {
  const upload = (over = {}) => api.uploadCapture({
    subjectKind: 'gateway', subjectId: 'gw-1', file: file(GOOD), note: 'line1.json',
    replace: true, expectedCaptureId: 'cap-old', ...over
  });

  it('begins on the server, writes the issued path, registers, and only then deletes the replaced file', async () => {
    const stored = await upload();
    expect(calls.log.map(([kind, what]) => [kind, what]))
      .toEqual([
        ['rpc', 'begin_capture_upload'],
        ['upload', ISSUED.storage_path],
        ['rpc', 'register_uploaded_capture'],
        ['remove', [ISSUED.replaces_storage_path]]
      ]);
    expect(calls.log[0][2]).toEqual({
      p_subject_kind: 'gateway', p_subject_id: 'gw-1', p_replace: true, p_expected_capture_id: 'cap-old'
    });
    // A fresh path, so nothing is overwritten.
    expect(calls.log[1][2]).toMatchObject({ upsert: false });
    expect(calls.log[2][2]).toMatchObject({ p_storage_path: ISSUED.storage_path, p_message_count: 2 });
    expect(stored).toMatchObject({ id: 'cap-new', path: ISSUED.storage_path, messages: 2 });
  });

  it('writes nothing when the server refuses to begin', async () => {
    calls.answers.begin_capture_upload = [{
      data: null,
      error: { code: '23505', message: 'begin_capture_upload: gwy120000000000400080000 is being recorded right now.' }
    }];
    await expect(upload()).rejects.toThrow('is being recorded right now');
    expect(calls.log.map(e => e[0])).toEqual(['rpc']);
  });

  it('deletes its own file, and nothing else, when the register is refused', async () => {
    calls.answers.register_uploaded_capture = [{
      data: null,
      error: { code: '23505', message: 'register_uploaded_capture: another capture of this subject was stored after this upload began' }
    }];
    await expect(upload()).rejects.toThrow('stored after this upload began');
    expect(calls.log.filter(e => e[0] === 'remove')).toEqual([['remove', [ISSUED.storage_path]]]);
  });

  it('deletes no replaced file when there was none', async () => {
    calls.answers.begin_capture_upload = [{
      data: { ...ISSUED, replaces_capture_id: null, replaces_storage_path: null }, error: null
    }];
    await upload({ replace: false, expectedCaptureId: null });
    expect(calls.log.filter(e => e[0] === 'remove')).toEqual([]);
  });

  it('refuses a malformed file before anything is sent', async () => {
    await expect(upload({ file: file(withMessage(1, m => ({ ...m, topic: 'spBv1.0/Aber/NCMD/gwy1' }))) }))
      .rejects.toThrow('message 1: message type "NCMD"');
    expect(calls.log).toEqual([]);
  });
});
