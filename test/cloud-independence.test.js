import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createDedicatedConnection } from '../src/services/connection/DedicatedConnectionAdapter.js';
import { createConnectionContext } from '../src/services/connection/ConnectionContext.js';
import { ConnectionPublicationManager } from '../src/services/connection/ConnectionPublicationManager.js';
import { ConnectionResolver } from '../src/services/connection/ConnectionResolver.js';

const APP_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const CONNECTION_ID = '11111111-2222-4333-8444-555555555555';

const relayPrivateKey = () => generateKeyPairSync('ed25519').privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64');

test('dedicated mode uses only local Discord and Nexus configuration', () => {
  const connection = createDedicatedConnection({
    config: {
      discord: {
        clientId: APP_ID,
        guildId: GUILD_ID,
      },
      nexusApi: {
        baseUrl: 'http://nexus.internal',
        connectionId: CONNECTION_ID,
        connectionGeneration: 3,
        relayProtocolVersion: 2,
        relayKeyId: 'dedicated-current',
        discordRelayPrivateKey: relayPrivateKey(),
      },
    },
  });

  assert.equal(connection.mode, 'dedicated');
  assert.equal(connection.source, 'environment');
  assert.equal(connection.endpointOrigin, 'http://nexus.internal');
  assert.equal(connection.connectionId, CONNECTION_ID);
  assert.equal(connection.generation, 3);
  assert.equal(connection.protocolVersion, 2);
});

test('operator-managed shared publication needs no Cloud account or endpoint', async () => {
  const now = Date.parse('2026-08-09T12:00:00Z');
  const resolver = new ConnectionResolver({
    mode: 'official-shared',
    applicationId: APP_ID,
    clock: () => now,
  });
  const publication = [{
    mode: 'official-shared',
    protocolVersion: 2,
    applicationId: APP_ID,
    guildId: GUILD_ID,
    connectionId: CONNECTION_ID,
    generation: 4,
    keyId: 'relay-current',
    endpointOrigin: 'https://nexus.example',
    expiresAt: '2026-08-09T13:00:00Z',
    capabilities: { commands: { nexus: 1 } },
  }];
  const manager = new ConnectionPublicationManager({
    source: { read: async () => structuredClone(publication) },
    resolver,
    applicationId: APP_ID,
    buildConnection: createConnectionContext,
    validateConnection: () => true,
    clock: () => now,
  });

  assert.deepEqual(await manager.refresh(), {
    accepted: true,
    changed: true,
    connectionCount: 1,
  });
  const connection = resolver.resolve({ guildId: GUILD_ID, applicationId: APP_ID });
  assert.equal(connection.endpointOrigin, 'https://nexus.example');
  assert.equal(connection.connectionId, CONNECTION_ID);
  assert.equal(connection.generation, 4);
});
