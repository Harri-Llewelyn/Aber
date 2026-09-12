import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePublicHost, publicAddressLines, publicAddressProblems } from './public-host.mjs';

test('blank is an answer, and produces two empty assignments', () => {
  assert.deepEqual(parsePublicHost('   '), { host: '' });
  assert.deepEqual(publicAddressLines('', 'SUPABASE_URL=http://127.0.0.1:54321\n'), {
    MQTT_PUBLIC_HOST: '',
    SUPABASE_PUBLIC_URL: '',
  });
});

test('a LAN name or IPv4 address is accepted and the URL follows the template port', () => {
  assert.deepEqual(parsePublicHost(' plant-pc.local '), { host: 'plant-pc.local' });
  assert.deepEqual(parsePublicHost('192.168.1.20'), { host: '192.168.1.20' });
  assert.deepEqual(publicAddressLines('plant-pc.local', 'SUPABASE_URL=http://127.0.0.1:8000\n'), {
    MQTT_PUBLIC_HOST: 'plant-pc.local',
    SUPABASE_PUBLIC_URL: 'http://plant-pc.local:8000',
  });
  assert.equal(publicAddressLines('h', 'nothing here').SUPABASE_PUBLIC_URL, 'http://h:54321');
});

test('in-stack names are refused with the reason, whatever the case', () => {
  for (const name of ['localhost', '127.0.0.1', 'Mosquitto', 'supabase-kong', '::1']) {
    const result = parsePublicHost(name);
    assert.ok(result.error, `${name} was accepted`);
  }
  assert.match(parsePublicHost('localhost').error, /resolves only on this machine/);
});

test('a URL, a port or a malformed name is refused rather than mangled', () => {
  assert.match(parsePublicHost('http://plant-pc:54321').error, /is a URL/);
  assert.match(parsePublicHost('plant-pc/api').error, /is a URL/);
  assert.match(parsePublicHost('plant-pc:54321').error, /port/);
  assert.match(parsePublicHost('plant pc').error, /not a hostname/);
  assert.match(parsePublicHost('-bad-').error, /not a hostname/);
});

test('a working .env is judged the way the two functions judge it', () => {
  assert.deepEqual(publicAddressProblems({ MQTT_PUBLIC_HOST: 'broker.plant', SUPABASE_PUBLIC_URL: 'http://api.plant:54321' }), []);
  assert.deepEqual(publicAddressProblems({}), ['MQTT_PUBLIC_HOST is unset', 'SUPABASE_PUBLIC_URL is unset']);
  const problems = publicAddressProblems({ MQTT_PUBLIC_HOST: 'mosquitto', SUPABASE_PUBLIC_URL: 'http://127.0.0.1:54321' });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /resolves only inside the stack/);
  assert.match(problems[1], /127\.0\.0\.1/);
});
