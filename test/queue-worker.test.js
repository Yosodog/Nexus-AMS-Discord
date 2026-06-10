import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueWorker } from '../src/services/QueueWorker.js';
import { createLogger, waitFor } from './helpers.js';

test('QueueWorker dispatches queue items and reports complete or failed status', async () => {
  const logger = createLogger();
  const statuses = [];
  const apiService = {
    fetchDiscordQueue: async () => ({
      data: [
        { id: 'queue-1', action: 'OK' },
        { id: 'queue-2', action: 'FAIL' },
      ],
    }),
    updateDiscordQueueStatus: async (id, status) => {
      statuses.push({ id, status });
    },
  };
  const dispatcher = {
    dispatch: async (item) => ({ success: item.action === 'OK' }),
  };
  const worker = new QueueWorker({
    apiService,
    dispatcher,
    logger,
    pollIntervalMs: 60_000,
  });

  worker.start();
  await waitFor(() => statuses.length === 2);
  worker.stop();

  assert.deepEqual(statuses, [
    { id: 'queue-1', status: 'complete' },
    { id: 'queue-2', status: 'failed' },
  ]);
});

test('QueueWorker skips queue items without ids', async () => {
  const logger = createLogger();
  const apiService = {
    fetchDiscordQueue: async () => ({ data: [{ action: 'MISSING_ID' }] }),
    updateDiscordQueueStatus: async () => assert.fail('item without id should not report status'),
  };
  const dispatcher = {
    dispatch: async () => assert.fail('item without id should not be dispatched'),
  };
  const worker = new QueueWorker({
    apiService,
    dispatcher,
    logger,
    pollIntervalMs: 60_000,
  });

  worker.start();
  await waitFor(() => logger.entries.warn.some(([message]) => message === 'Skipping queue item without an id'));
  worker.stop();
});

test('QueueWorker increases poll backoff after network fetch failures', async () => {
  const logger = createLogger();
  const apiService = {
    fetchDiscordQueue: async () => {
      const error = new Error('socket reset');
      error.code = 'ECONNRESET';
      throw error;
    },
    updateDiscordQueueStatus: async () => assert.fail('no queue items should be reported'),
  };
  const worker = new QueueWorker({
    apiService,
    dispatcher: { dispatch: async () => ({ success: true }) },
    logger,
    pollIntervalMs: 10,
    maxBackoffMs: 100,
  });

  worker.start();
  await waitFor(() => worker.currentPollIntervalMs === 20);
  worker.stop();

  assert.equal(worker.backoffAttempts, 1);
});
