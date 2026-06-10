import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiService } from '../src/services/ApiService.js';
import { createLogger } from './helpers.js';

function createApiService(options = {}) {
  return new ApiService({
    baseUrl: 'https://nexus.example',
    apiKey: 'secret-key',
    logger: createLogger(),
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

test('ApiService does not retry non-retryable API responses', async () => {
  const service = createApiService({ maxRetries: 3 });
  let attempts = 0;
  service.http.request = async () => {
    attempts += 1;
    const error = new Error('Bad request');
    error.response = { status: 400 };
    throw error;
  };

  await assert.rejects(() => service.request({ method: 'get', url: '/bad' }), /Bad request/);
  assert.equal(attempts, 1);
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
