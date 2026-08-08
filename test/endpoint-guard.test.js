import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPublicDnsResults,
  createPublicHttpsAgent,
  isPublicHost,
  validateNexusEndpoint,
} from '../src/services/connection/EndpointGuard.js';

test('shared endpoint validation allows only public HTTPS origins', () => {
  assert.equal(validateNexusEndpoint('https://nexus.example', { shared: true }), 'https://nexus.example');
  assert.equal(validateNexusEndpoint('https://nexus.example:8443', { shared: true }), 'https://nexus.example:8443');
  assert.throws(() => validateNexusEndpoint('http://nexus.example', { shared: true }), /HTTPS/);
  assert.throws(() => validateNexusEndpoint('https://nexus.example/api', { shared: true }), /path/);
  assert.throws(() => validateNexusEndpoint('https://user:pass@nexus.example', { shared: true }), /credentials/);
});

test('shared endpoint validation rejects private, metadata, and mapped private addresses', () => {
  for (const host of [
    'localhost', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', 'metadata.google.internal', '[::1]', '[fd00::1]',
    '[::ffff:127.0.0.1]', '[ff02::1]', '[2001:db8::1]',
    '2130706433', '0x7f000001', '0177.0.0.1', '127.1',
  ]) {
    assert.equal(isPublicHost(host), false, host);
    assert.throws(() => validateNexusEndpoint(`https://${host}`, { shared: true }), /public host/);
  }
});

test('DNS results fail closed when any resolved address is private', () => {
  assert.deepEqual(assertPublicDnsResults([{ address: '8.8.8.8' }]), [{ address: '8.8.8.8' }]);
  assert.throws(() => assertPublicDnsResults([{ address: '8.8.8.8' }, { address: '127.0.0.1' }]), /private/);
  assert.throws(() => assertPublicDnsResults([{ address: '::ffff:127.0.0.1' }]), /private/);
});

test('shared HTTPS transport resolves every socket and rejects DNS rebinding', async () => {
  let lookups = 0;
  const agent = createPublicHttpsAgent('https://nexus.example:8443', {
    lookup: async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    },
  });

  const lookup = (options = {}) => new Promise((resolve, reject) => {
    agent.options.lookup('nexus.example', options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });

  assert.deepEqual(await lookup(), { address: '8.8.8.8', family: 4 });
  await assert.rejects(() => lookup(), /private or reserved/);
  assert.equal(lookups, 2);
  assert.equal(agent.options.keepAlive, false);
  assert.equal(agent.options.rejectUnauthorized, true);
  assert.equal(agent.options.servername, 'nexus.example');
  agent.destroy();
});
