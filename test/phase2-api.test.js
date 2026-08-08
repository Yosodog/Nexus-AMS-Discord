import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { createServer } from 'node:http';
import { ApiService } from '../src/services/ApiService.js';
import { DiscordRelaySigner, RelayHeaders } from '../src/services/DiscordRelaySigner.js';
import { createLogger } from './helpers.js';

const APP_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const CONNECTION_ID = '11111111-2222-4333-8444-555555555555';
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const PRIVATE_KEY_BASE64 = PRIVATE_KEY.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const connection = {
  mode: 'official-shared',
  applicationId: APP_ID,
  guildId: GUILD_ID,
  connectionId: CONNECTION_ID,
  generation: 7,
  keyId: 'relay-current',
  protocolVersion: 2,
};

const createService = () => new ApiService({
  baseUrl: 'https://nexus.example',
  apiKey: 'connection-api-key',
  logger: createLogger(),
  connectionContext: connection,
  relaySigner: new DiscordRelaySigner({
    privateKeyBase64: PRIVATE_KEY_BASE64,
    appId: APP_ID,
    guildId: GUILD_ID,
    connectionId: CONNECTION_ID,
    generation: 7,
    protocolVersion: 2,
    keyId: 'relay-current',
    clock: () => Date.parse('2026-08-08T12:00:00Z'),
    randomUUID: () => '33333333-4444-4555-8666-777777777777',
  }),
  maxRetries: 1,
});

const documentFrom = (request) => JSON.parse(Buffer.from(
  request.headers[RelayHeaders.PAYLOAD],
  'base64url',
).toString('utf8'));

test('ApiService uses the locked v2 queue action names and connection body fields', async () => {
  const service = createService();
  const requests = [];
  service.http.request = async (request) => {
    requests.push(request);
    if (request.url.endsWith('/queue/claim')) {
      return { data: { item: {
        id: 'delivery-1',
        lease_token: 'lease-1',
        connection_id: CONNECTION_ID,
        application_id: APP_ID,
        guild_id: GUILD_ID,
        generation: 7,
      } } };
    }
    return { data: { ok: true } };
  };

  await service.claimDiscordQueue('worker-1', 'request-1', 'alerts', GUILD_ID, connection);
  await service.renewDiscordQueueLease('delivery-1', 'lease-1');
  await service.checkpointDiscordQueue('delivery-1', 'lease-1', { sent: true });
  await service.updateDiscordQueueStatus('delivery-1', 'complete', 'lease-1');

  assert.deepEqual(requests[0].data, {
    worker_id: 'worker-1',
    request_id: 'request-1',
    lanes: ['alerts'],
    guild_id: GUILD_ID,
    connection_id: CONNECTION_ID,
    generation: 7,
    application_id: APP_ID,
  });
  assert.deepEqual(requests.map(documentFrom).map((document) => document.proof.action), [
    'queue.claim',
    'queue.lease',
    'queue.checkpoint',
    'queue.acknowledge',
  ]);
});

test('ApiService rejects a non-empty v2 queue claim without a bound item', async () => {
  const service = createService();
  service.http.request = async () => ({ data: { data: { ok: true } } });

  await assert.rejects(
    () => service.claimDiscordQueue('worker-1', 'request-1', 'alerts', GUILD_ID, connection),
    (error) => error?.code === 'INVALID_QUEUE_BINDING' && error?.details?.field === 'item',
  );
});

test('ApiService signs Nexus status as the nexus.status interaction action', async () => {
  const service = createService();
  let request;
  service.http.request = async (options) => {
    request = options;
    return { data: { data: { provider: { version: '2026.08' } }, meta: { contract_version: 1 } } };
  };
  await service.getNexusStatus({
    discordUserId: '423456789012345678',
    discordGuildId: GUILD_ID,
    discordInteractionId: '323456789012345678',
    discordCommand: 'nexus',
    discordAction: 'nexus.status',
  });
  const document = documentFrom(request);
  assert.equal(new URL(request.url).pathname, '/api/v1/discord/status');
  assert.equal(document.proof.command, 'nexus');
  assert.equal(document.proof.action, 'nexus.status');
  assert.equal(document.method, 'GET');
  assert.equal(document.normalized_path_query, '/api/v1/discord/status');
});

test('v2 permits every registered service-proof route and uses the exact signed URL', async () => {
  const service = createService();
  const requests = [];
  service.http.request = async (options) => {
    requests.push(options);
    return { data: { ok: true } };
  };

  await service.getAlertRendererManifest();
  await service.attachWarCounterChannel({ war_counter_id: 'counter-1', discord_channel_id: '523456789012345678' });
  await service.attachMilcomObjectiveRoom({ objective_id: 1, dispatch_id: 2, discord_channel_id: '623456789012345678' });
  await service.logApplicationMessage({ content: 'safe transcript', discord_message_id: '723456789012345678' });
  await service.sendIntelReport({ report: 'safe intel' });

  assert.deepEqual(requests.map(documentFrom).map((document) => document.proof.action), [
    'alerts.manifest',
    'war-counters.attach-channel',
    'milcom.objectives.attach-room',
    'applications.message',
    'intel.report',
  ]);
  for (const request of requests) {
    const document = documentFrom(request);
    assert.equal(request.url, `https://nexus.example${document.normalized_path_query}`);
  }
});

test('shared transport disables redirects and proxies and bounds request/response sizes', () => {
  const service = createService();
  assert.equal(service.http.defaults.maxRedirects, 0);
  assert.equal(service.http.defaults.proxy, false);
  assert.equal(service.http.defaults.maxContentLength, 1_048_576);
  assert.equal(service.http.defaults.maxBodyLength, 262_144);
  assert.equal(service.http.defaults.httpsAgent.options.rejectUnauthorized, true);
});

test('bounded response size rejects an oversized Nexus response', async (t) => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/plain');
    response.end('oversized-response-body');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const service = new ApiService({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: 'connection-api-key',
    logger: createLogger(),
    maxResponseBytes: 8,
    maxRetries: 1,
  });
  await assert.rejects(
    () => service.request({ method: 'get', url: `${service.baseUrl}/oversized` }),
    /maxContentLength|exceeded/i,
  );
});

test('redirect responses are not followed by the Nexus transport', async (t) => {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/final' });
      response.end();
      return;
    }
    response.end('final');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const service = new ApiService({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: 'connection-api-key',
    logger: createLogger(),
    maxRetries: 1,
  });
  await assert.rejects(
    () => service.request({ method: 'get', url: `${service.baseUrl}/redirect` }),
    (error) => error?.response?.status === 302,
  );
  assert.equal(hits, 1);
});

test('v2 canonicalizes URLSearchParams output before signing and dispatch', async () => {
  const service = createService();
  let request;
  service.http.request = async (options) => {
    request = options;
    return { data: { data: { accounts: [] }, meta: { contract_version: 1 } } };
  };
  await service.getMyAccounts({
    discordUserId: '423456789012345678',
    discordGuildId: GUILD_ID,
    discordInteractionId: '323456789012345678',
    discordCommand: 'accounts',
    discordAction: 'accounts.list',
  }, { query: 'z ~+', limit: 7 });

  const document = documentFrom(request);
  assert.equal(request.url, `https://nexus.example${document.normalized_path_query}`);
  assert.equal(
    request.url,
    'https://nexus.example/api/v1/discord/me/accounts?limit=7&query=z%20~%2B',
  );
});
