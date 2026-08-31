import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionContext } from '../src/services/connection/ConnectionContext.js';
import { publishInitialConnections } from '../src/services/connection/InitialConnectionPublication.js';
import { ConnectionResolver } from '../src/services/connection/ConnectionResolver.js';
import { createLogger } from './helpers.js';

const APP_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const CONNECTION_A = '11111111-2222-4333-8444-555555555555';
const CONNECTION_B = '66666666-7777-4777-8888-999999999999';
const TEST_NOW = Date.parse('2026-08-08T12:00:00Z');

const rawConnection = (overrides = {}) => ({
  mode: 'official-shared',
  protocolVersion: 2,
  applicationId: APP_ID,
  guildId: GUILD_ID,
  connectionId: CONNECTION_A,
  generation: 7,
  keyId: 'relay-current',
  endpointOrigin: 'https://nexus.example',
  expiresAt: '2026-08-08T13:00:00Z',
  capabilities: { commands: { nexus: 1 } },
  ...overrides,
});

const resolver = () => new ConnectionResolver({
  mode: 'official-shared',
  applicationId: APP_ID,
  clock: () => TEST_NOW,
});

test('initial shared connections are validated and published as one atomic snapshot', async () => {
  const connections = resolver();
  const result = await publishInitialConnections({
    publication: [rawConnection()],
    resolver: connections,
    applicationId: APP_ID,
    buildConnection: createConnectionContext,
    validateConnection: () => true,
    logger: createLogger(),
    clock: () => TEST_NOW,
  });

  assert.deepEqual(result, { accepted: true, changed: true, connectionCount: 1 });
  assert.equal(connections.resolve({ guildId: GUILD_ID }).connectionId, CONNECTION_A);
});

test('an invalid initial shared snapshot publishes no partial routes', async () => {
  const connections = resolver();
  const result = await publishInitialConnections({
    publication: [
      rawConnection(),
      rawConnection({ connectionId: CONNECTION_B, generation: 8 }),
    ],
    resolver: connections,
    applicationId: APP_ID,
    buildConnection: createConnectionContext,
    validateConnection: () => true,
    logger: createLogger(),
    clock: () => TEST_NOW,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, 'AMBIGUOUS_ACTIVE_CONNECTION');
  assert.deepEqual(connections.list({ includeInactive: true }), []);
});

test('unusable credentials reject the complete initial snapshot', async () => {
  const connections = resolver();
  const result = await publishInitialConnections({
    publication: [rawConnection()],
    resolver: connections,
    applicationId: APP_ID,
    buildConnection: createConnectionContext,
    validateConnection: () => false,
    logger: createLogger(),
    clock: () => TEST_NOW,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, 'INVALID_CONNECTION_CREDENTIALS');
  assert.deepEqual(connections.list({ includeInactive: true }), []);
});
