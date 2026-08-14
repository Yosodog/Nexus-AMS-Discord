import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ApiService } from '../src/services/ApiService.js';
import { DiscordRelaySigner } from '../src/services/DiscordRelaySigner.js';
import { createConnectionContext } from '../src/services/connection/ConnectionContext.js';
import { queueActions } from '../src/services/queueActions/index.js';
import { DiscordStatusService } from '../src/services/status/DiscordStatusService.js';
import { buildQueueWorkerDefinitions } from '../src/services/QueueWorkerDefinitions.js';
import { createLogger } from './helpers.js';

const APP_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const CONNECTION_ID = '11111111-2222-4333-8444-555555555555';
const { privateKey } = generateKeyPairSync('ed25519');
const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

const connection = Object.freeze({
  mode: 'dedicated',
  protocolVersion: 2,
  applicationId: APP_ID,
  guildId: GUILD_ID,
  connectionId: CONNECTION_ID,
  generation: 7,
  keyId: 'relay-current',
});

const createService = () => new ApiService({
  baseUrl: 'https://nexus.example',
  apiKey: 'secret-key',
  logger: createLogger(),
  connectionContext: connection,
  relaySigner: new DiscordRelaySigner({
    privateKeyBase64,
    appId: APP_ID,
    guildId: GUILD_ID,
    connectionId: CONNECTION_ID,
    generation: 7,
    protocolVersion: 2,
    keyId: 'relay-current',
  }),
  maxRetries: 1,
});

test('queue worker definitions are always explicit and preserve side effects when alerts degrade', () => {
  assert.deepEqual(buildQueueWorkerDefinitions({ alertLanesEnabled: true }), [
    { lane: 'side_effects', enabled: true },
    { lane: 'alerts', enabled: true },
    { lane: 'digests', enabled: true },
  ]);
  assert.deepEqual(buildQueueWorkerDefinitions({ alertLanesEnabled: false }), [
    { lane: 'side_effects', enabled: true },
    { lane: 'alerts', enabled: false },
    { lane: 'digests', enabled: false },
  ]);
  assert.equal(buildQueueWorkerDefinitions({ alertLanesEnabled: false }).some(({ lane }) => lane === null), false);
});

test('claimDiscordQueue requires an explicit lane and complete relay-v2 binding', async () => {
  const service = createService();
  const requests = [];
  service.http.request = async (request) => {
    requests.push(request);
    return { data: { data: null } };
  };

  await assert.rejects(
    () => service.claimDiscordQueue('worker-1', 'request-1', '', GUILD_ID, connection),
    /non-empty queue lane/i,
  );
  await assert.rejects(
    () => service.claimDiscordQueue('worker-1', 'request-2', 'alerts', GUILD_ID, {
      ...connection,
      protocolVersion: 1,
    }),
    /relay protocol v2/i,
  );

  await service.claimDiscordQueue('worker-1', 'request-3', 'alerts', GUILD_ID, connection);
  assert.deepEqual(requests[0].data, {
    worker_id: 'worker-1',
    request_id: 'request-3',
    lanes: ['alerts'],
    guild_id: GUILD_ID,
    connection_id: CONNECTION_ID,
    generation: 7,
    application_id: APP_ID,
  });
});

test('legacy queue fetch and dead direct API methods are absent', () => {
  const service = createService();
  for (const method of [
    'fetchDiscordQueue',
    'createApplication',
    'attachApplicationChannel',
    'approveApplication',
    'denyApplication',
    'verifyUser',
    'sweepPrimaryOffshore',
  ]) {
    assert.equal(service[method], undefined, `${method} should not be exposed`);
  }
});

test('relay-v2 is the only accepted signer and connection protocol', () => {
  assert.throws(
    () => new DiscordRelaySigner({
      privateKeyBase64,
      appId: APP_ID,
      guildId: GUILD_ID,
      connectionId: CONNECTION_ID,
      protocolVersion: 1,
    }),
    /relay protocol v2/i,
  );
  assert.throws(
    () => createConnectionContext({
      ...connection,
      protocolVersion: 3,
      endpointOrigin: 'https://nexus.example',
    }),
    /relay protocol v2/i,
  );
});

test('status no longer advertises legacy queue lanes', () => {
  const service = new DiscordStatusService({
    client: { ws: { status: 0 }, guilds: { cache: new Map() } },
    connectionResolver: { diagnostics: () => ({ connected: true }) },
  });
  const status = service.getStatus();
  assert.equal(status.capabilities.reads_legacy_queue_lanes, undefined);
});

test('blockade relief is delivered through PRIVATE_NOTIFICATION only', () => {
  assert.equal(queueActions.BLOCKADE_RELIEF_NOTIFICATION, undefined);
  assert.ok(queueActions.PRIVATE_NOTIFICATION);
});
