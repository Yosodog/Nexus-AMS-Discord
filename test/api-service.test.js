import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ApiService, RetryMode } from '../src/services/ApiService.js';
import { DiscordRelaySigner } from '../src/services/DiscordRelaySigner.js';
import { createLogger } from './helpers.js';

const GUILD_ID = '223456789012345678';
const { privateKey: relayPrivateKey } = generateKeyPairSync('ed25519');
const relayPrivateKeyBase64 = relayPrivateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

function createApiService(options = {}) {
  return new ApiService({
    baseUrl: 'https://nexus.example',
    apiKey: 'secret-key',
    logger: createLogger(),
    relaySigner: new DiscordRelaySigner({
      privateKeyBase64: relayPrivateKeyBase64,
      guildId: GUILD_ID,
      clock: () => 1_700_000_000_000,
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
    }),
    maxRetries: 1,
    ...options,
  });
}

test('ApiService builds queue fetch and status update requests', async () => {
  const service = createApiService();
  const requests = [];
  service.http.request = async (options) => {
    requests.push(options);
    return { data: { ok: true } };
  };

  assert.deepEqual(await service.fetchDiscordQueue(7), { ok: true });
  assert.deepEqual(await service.updateDiscordQueueStatus('queue-1', 'complete'), { ok: true });

  assert.equal(requests[0].method, 'get');
  assert.equal(requests[0].url, 'https://nexus.example/api/v1/discord/queue?limit=7');
  assert.equal(requests[1].method, 'post');
  assert.equal(requests[1].url, 'https://nexus.example/api/v1/discord/queue/queue-1/status');
  assert.deepEqual(requests[1].data, { status: 'complete' });
});

test('ApiService builds leased queue and war-counter requests', async () => {
  const service = createApiService();
  const requests = [];
  service.http.request = async (options) => {
    requests.push(options);
    return { data: { ok: true } };
  };

  await service.claimDiscordQueue('worker-1', 'request-1');
  await service.renewDiscordQueueLease('queue-1', 'lease-1');
  await service.checkpointDiscordQueue('queue-1', 'lease-1', { discord_channel_id: '123' });
  await service.updateDiscordQueueStatus('queue-1', 'failed', 'lease-1', {
    error_code: 'send_failed',
    error_message: 'Discord rejected the message',
  });
  await service.getWarCounter(77);

  assert.deepEqual(requests.map(({ method }) => method), ['post', 'post', 'patch', 'post', 'get']);
  assert.deepEqual(requests[0].data, { worker_id: 'worker-1', request_id: 'request-1' });
  assert.deepEqual(requests[2].data, {
    lease_token: 'lease-1',
    result: { discord_channel_id: '123' },
  });
  assert.deepEqual(requests[3].data, {
    status: 'failed',
    lease_token: 'lease-1',
    error_code: 'send_failed',
    error_message: 'Discord rejected the message',
  });
  assert.equal(requests[4].url, 'https://nexus.example/api/v1/discord/war-counters/77');
});

test('ApiService exposes all Nexus mutation endpoints through the shared transport', async () => {
  const service = createApiService();
  const requests = [];
  service.http.request = async (options) => {
    requests.push(options);
    return { data: { ok: true } };
  };

  await service.createApplication({ nation_id: 1 });
  await service.attachApplicationChannel({ application_id: 1, discord_channel_id: '123' });
  await service.attachWarCounterChannel({ war_counter_id: 1, discord_channel_id: '123' });
  const actor = {
    discordUserId: '123456789012345678',
    discordGuildId: GUILD_ID,
    discordInteractionId: '323456789012345678',
  };
  await service.archiveWarCounter({ war_counter_id: 1, moderator_discord_id: actor.discordUserId }, {
    ...actor, discordCommand: 'archivecounter',
  });
  await service.sweepPrimaryOffshore({ moderator_discord_id: actor.discordUserId, request_id: 'request' }, {
    ...actor, discordCommand: 'sweepbank',
  });
  await service.logApplicationMessage({ discord_message_id: '789' });
  await service.sendIntelReport({ report: 'intel' });
  await service.approveApplication({ applicant_discord_id: '123', moderator_discord_id: actor.discordUserId }, {
    ...actor, discordCommand: 'approve',
  });
  await service.denyApplication({ applicant_discord_id: '123', moderator_discord_id: actor.discordUserId }, {
    ...actor, discordCommand: 'deny',
  });

  assert.equal(requests.length, 9);
  assert.deepEqual(requests.map(({ method }) => method), Array(9).fill('post'));
  assert.equal(requests.every(({ headers }) => headers.Authorization === 'Bearer secret-key'), true);
});

test('ApiService routes the expanded actor command contract with strict headers and envelopes', async () => {
  const service = createApiService();
  const requests = [];
  service.http.request = async (options) => {
    requests.push(options);
    return { data: { data: { ok: true }, meta: { contract_version: 1 } } };
  };
  const actor = {
    discordUserId: '123456789012345678',
    discordGuildId: GUILD_ID,
    discordInteractionId: '323456789012345678',
  };

  const calls = [
    () => service.getMyAccounts(actor, { query: 'main' }),
    () => service.createDepositRequest(actor, '1', {}),
    () => service.createWithdrawalDraft(actor, { account_id: 1, resources: {} }),
    () => service.getWithdrawalIntent(actor, 'token'),
    () => service.confirmWithdrawal(actor, 'token'),
    () => service.cancelWithdrawal(actor, 'token'),
    () => service.getMyTransactions(actor, { account: '1' }),
    () => service.getMyRequests(actor),
    () => service.getGrantPrograms(actor),
    () => service.previewGrantApplication(actor, {}),
    () => service.confirmGrantApplication(actor, {}),
    () => service.previewCityGrantRequest(actor, {}),
    () => service.confirmCityGrantRequest(actor, {}),
    () => service.getMyGrantRequests(actor),
    () => service.previewLoanApplication(actor, {}),
    () => service.confirmLoanApplication(actor, {}),
    () => service.getMyLoans(actor),
    () => service.previewLoanPayment(actor, {}),
    () => service.confirmLoanPayment(actor, {}),
    () => service.createWarAidDraft(actor, {}),
    () => service.reviewWarAidDraft(actor, {}),
    () => service.confirmWarAidRequest(actor, {}),
    () => service.getMyWarAidRequests(actor),
    () => service.confirmRebuildRequest(actor, {}),
    () => service.previewRebuildRequest(actor, {}),
    () => service.getMyRebuildRequests(actor),
    () => service.getMyRaidAssignments(actor),
    () => service.getMyWarAssignments(actor),
    () => service.getMyActiveWars(actor),
    () => service.respondToWarAssignment(actor, 'plan', 7, { response: 'acknowledged' }),
    () => service.getWarCounterRecommendation(actor, 9),
    () => service.getWarSimulation(actor, '11'),
    () => service.getMySpyAssignments(actor),
    () => service.getStaffApplications(actor),
    () => service.getMyApplications(actor),
    () => service.getStaffApplicationReview(actor, { application: '12' }),
    () => service.decideStaffApplication(actor, '12', 'approve'),
    () => service.getStaffRequests(actor),
  ];

  for (const call of calls) assert.deepEqual(await call(), { ok: true });
  assert.equal(requests.length, calls.length);
  assert.equal(requests.every(({ headers }) => headers['X-Discord-User-ID'] === actor.discordUserId), true);
  assert.equal(requests.every(({ headers }) => typeof headers['X-Nexus-Discord-Relay-Signature'] === 'string'), true);
  assert.equal(requests.filter(({ method }) => method !== 'get')
    .every(({ headers }) => headers['X-Discord-Interaction-ID'] === actor.discordInteractionId), true);
});

test('ApiService does not retry non-retryable API responses', async () => {
  const service = createApiService({ maxRetries: 3 });
  let attempts = 0;
  service.http.request = async () => {
    attempts += 1;
    const error = new Error('Bad request');
    error.response = { status: 400 };
    throw error;
  };

  await assert.rejects(() => service.request({ method: 'get', url: '/bad' }, RetryMode.SAFE), /Bad request/);
  assert.equal(attempts, 1);
});

test('ApiService retries only safe/idempotent transient failures and honors Retry-After', async () => {
  const sleeps = [];
  const service = createApiService({
    maxRetries: 3,
    random: () => 0,
    sleep: async (duration) => sleeps.push(duration),
  });
  let attempts = 0;
  service.http.request = async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('Rate limited');
      error.response = { status: 429, headers: { 'retry-after': '0.25' } };
      throw error;
    }
    return { data: { ok: true } };
  };

  assert.deepEqual(await service.request({ method: 'post', url: '/safe' }, RetryMode.IDEMPOTENT), { ok: true });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [250, 250]);

  attempts = 0;
  service.http.request = async () => {
    attempts += 1;
    const error = new Error('Response lost');
    error.code = 'ECONNRESET';
    throw error;
  };
  await assert.rejects(() => service.request({ method: 'post', url: '/unsafe' }, RetryMode.NEVER));
  assert.equal(attempts, 1);
});

test('ApiService retries network, 408, and 5xx failures with bounded exponential jitter', async () => {
  for (const failure of [
    { code: 'ECONNRESET' },
    { response: { status: 408, headers: {} } },
    { response: { status: 503, headers: {} } },
  ]) {
    const sleeps = [];
    const service = createApiService({
      maxRetries: 2,
      random: () => 0.5,
      sleep: async (duration) => sleeps.push(duration),
    });
    let attempts = 0;
    service.http.request = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('transient'), failure);
      return { data: { ok: true } };
    };

    assert.deepEqual(await service.request({ method: 'get', url: '/retry' }, RetryMode.SAFE), { ok: true });
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [562]);
  }
});

test('ApiService validates retry modes and supports HTTP-date Retry-After headers', async () => {
  const sleeps = [];
  const service = createApiService({
    maxRetries: 2,
    sleep: async (duration) => sleeps.push(duration),
  });
  await assert.rejects(
    () => service.request({ method: 'get', url: '/bad-mode' }, 'sometimes'),
    /Unknown API retry mode/,
  );

  let attempts = 0;
  service.http.request = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('busy');
      error.response = {
        status: 503,
        headers: { get: () => new Date(Date.now() + 60_000).toUTCString() },
      };
      throw error;
    }
    return { data: { ok: true } };
  };
  await service.request({ method: 'get', url: '/date-retry' }, RetryMode.SAFE);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0] > 50_000 && sleeps[0] <= 60_000, true);
});

test('ApiService verifyUser normalizes API errors and redacts token details', async () => {
  const service = createApiService();
  service.http.post = async () => {
    const error = new Error('Conflict');
    error.response = {
      status: 409,
      data: {
        message: 'Already linked.',
        token: 'secret-user-token',
      },
    };
    throw error;
  };

  const result = await service.verifyUser({
    token: 'secret-user-token',
    discord_id: 'user-1',
    discord_username: 'Tester',
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'CONFLICT');
  assert.equal(result.message, 'Already linked.');
  assert.equal(result.details.token, '[REDACTED]');
  assert.equal(result.error.details.token, '[REDACTED]');
});

test('ApiService verifyUser returns network and setup failures without throwing', async () => {
  const networkService = createApiService();
  networkService.http.post = async () => {
    const error = new Error('No response');
    error.request = {};
    throw error;
  };

  const networkResult = await networkService.verifyUser({ token: 'code' });
  assert.equal(networkResult.success, false);
  assert.equal(networkResult.code, 'NETWORK_ERROR');

  const setupService = createApiService();
  setupService.http.post = async () => {
    throw new Error('Invalid config');
  };

  const setupResult = await setupService.verifyUser({ token: 'code' });
  assert.equal(setupResult.success, false);
  assert.equal(setupResult.code, 'UNEXPECTED_ERROR');
});
