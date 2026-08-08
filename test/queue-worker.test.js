import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueWorker } from '../src/services/QueueWorker.js';
import { createLogger, waitFor } from './helpers.js';

const futureLease = () => new Date(Date.now() + 60_000).toISOString();

test('QueueWorker health snapshot exposes no worker, queue, or lease identifiers', async () => {
  const worker = new QueueWorker({
    apiService: {},
    dispatcher: {},
    logger: createLogger(),
    workerId: 'must-not-appear',
  });

  assert.deepEqual(worker.getHealthSnapshot(), {
    started: false,
    stopped: false,
    polling: false,
    active_item: false,
    lease_healthy: null,
    backoff_attempts: 0,
  });
  await worker.stop();
  const stopped = worker.getHealthSnapshot();
  assert.equal(stopped.stopped, true);
  assert.doesNotMatch(JSON.stringify(stopped), /must-not-appear|queueId|lease_token/i);
});

function leased(id, action) {
  return {
    id,
    action,
    lease_token: `lease-${id}`,
    leased_until: futureLease(),
    attempts: 1,
  };
}

test('QueueWorker drains one leased item at a time and sends tokenized outcomes', async () => {
  const logger = createLogger();
  const statuses = [];
  const claims = [leased('queue-1', 'OK'), leased('queue-2', 'FAIL'), null];
  const apiService = {
    claimDiscordQueue: async () => ({ data: claims.shift() ?? null }),
    renewDiscordQueueLease: async () => ({ data: { leased_until: futureLease() } }),
    updateDiscordQueueStatus: async (...args) => statuses.push(args),
  };
  const dispatcher = {
    dispatch: async (item) => ({ success: item.action === 'OK', reason: 'test_failure' }),
  };
  const worker = new QueueWorker({
    apiService,
    dispatcher,
    logger,
    pollIntervalMs: 60_000,
    workerId: '123e4567-e89b-12d3-a456-426614174000',
  });

  worker.start();
  await waitFor(() => statuses.length === 2);
  await worker.stop();

  assert.deepEqual(statuses[0], ['queue-1', 'complete', 'lease-queue-1', {}]);
  assert.equal(statuses[1][0], 'queue-2');
  assert.equal(statuses[1][1], 'failed');
  assert.equal(statuses[1][2], 'lease-queue-2');
});

test('QueueWorker propagates successful queue action results in completion acknowledgement', async () => {
  const statuses = [];
  let claimed = false;
  const worker = new QueueWorker({
    apiService: {
      claimDiscordQueue: async () => {
        if (claimed) return { data: null };
        claimed = true;
        return { data: leased('queue-result', 'PRIVATE_NOTIFICATION') };
      },
      renewDiscordQueueLease: async () => ({ data: { leased_until: futureLease() } }),
      updateDiscordQueueStatus: async (...args) => statuses.push(args),
    },
    dispatcher: { dispatch: async () => ({ success: true, result: { delivery: 'undeliverable' } }) },
    logger: createLogger(),
    pollIntervalMs: 60_000,
  });
  worker.start();
  await waitFor(() => statuses.length === 1);
  await worker.stop();
  assert.deepEqual(statuses[0], [
    'queue-result', 'complete', 'lease-queue-result', { result: { delivery: 'undeliverable' } },
  ]);
});

test('QueueWorker rejects malformed claim responses without dispatching', async () => {
  const logger = createLogger();
  const apiService = {
    claimDiscordQueue: async () => ({ data: { action: 'MISSING_ID', lease_token: 'lease' } }),
    updateDiscordQueueStatus: async () => assert.fail('malformed item should not report status'),
  };
  const worker = new QueueWorker({
    apiService,
    dispatcher: { dispatch: async () => assert.fail('malformed item should not dispatch') },
    logger,
    pollIntervalMs: 60_000,
  });

  worker.start();
  await waitFor(() => logger.entries.error.some(([message]) => message === 'Claim response missing queue id or lease token'));
  await worker.stop();
});

test('QueueWorker increases claim backoff after network failures', async () => {
  const logger = createLogger();
  const apiService = {
    claimDiscordQueue: async () => {
      const error = new Error('socket reset');
      error.code = 'ECONNRESET';
      throw error;
    },
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
  await worker.stop();

  assert.equal(worker.backoffAttempts, 1);
});

test('QueueWorker retries acknowledgement before claiming another item', async () => {
  const logger = createLogger();
  const events = [];
  let claimed = false;
  let statusAttempts = 0;
  const apiService = {
    claimDiscordQueue: async () => {
      events.push('claim');
      if (claimed) return { data: null };
      claimed = true;
      return { data: leased('queue-1', 'OK') };
    },
    renewDiscordQueueLease: async () => ({ data: { leased_until: futureLease() } }),
    updateDiscordQueueStatus: async () => {
      statusAttempts += 1;
      events.push(`status-${statusAttempts}`);
      if (statusAttempts === 1) throw new Error('response lost');
    },
  };
  const worker = new QueueWorker({
    apiService,
    dispatcher: { dispatch: async () => ({ success: true }) },
    logger,
    acknowledgementBackoffMs: 1,
    pollIntervalMs: 60_000,
  });

  worker.start();
  await waitFor(() => statusAttempts === 2);
  await worker.stop();

  assert.deepEqual(events.slice(0, 3), ['claim', 'status-1', 'status-2']);
});

test('QueueWorker stops acknowledgement retries on a rejected lease token', async () => {
  const logger = createLogger();
  let statusAttempts = 0;
  let claimed = false;
  const apiService = {
    claimDiscordQueue: async () => {
      if (claimed) return { data: null };
      claimed = true;
      return { data: leased('queue-1', 'OK') };
    },
    renewDiscordQueueLease: async () => ({ data: { leased_until: futureLease() } }),
    updateDiscordQueueStatus: async () => {
      statusAttempts += 1;
      const error = new Error('conflict');
      error.response = { status: 409 };
      throw error;
    },
  };
  const worker = new QueueWorker({
    apiService,
    dispatcher: { dispatch: async () => ({ success: true }) },
    logger,
    pollIntervalMs: 60_000,
  });

  worker.start();
  await waitFor(() => logger.entries.warn.some(([message]) => message.includes('acknowledgement rejected')));
  await worker.stop();
  assert.equal(statusAttempts, 1);
});

test('QueueWorker does not acknowledge inside the lease safety window', async () => {
  const logger = createLogger();
  let statusAttempts = 0;
  const item = leased('queue-1', 'OK');
  item.leased_until = new Date(Date.now() + 2).toISOString();
  let claimed = false;
  const worker = new QueueWorker({
    apiService: {
      claimDiscordQueue: async () => {
        if (claimed) return { data: null };
        claimed = true;
        return { data: item };
      },
      renewDiscordQueueLease: async () => ({ data: { leased_until: futureLease() } }),
      updateDiscordQueueStatus: async () => { statusAttempts += 1; },
    },
    dispatcher: { dispatch: async () => ({ success: true }) },
    logger,
    pollIntervalMs: 60_000,
    leaseSafetyMs: 5,
  });

  worker.start();
  await waitFor(() => logger.entries.error.some(([message]) => message.includes('before lease expiry')));
  await worker.stop();
  assert.equal(statusAttempts, 0);
});

test('QueueWorker fails a successful dispatch when its lease was lost during the final call', async () => {
  const logger = createLogger();
  let status;
  let claimed = false;
  const apiService = {
    claimDiscordQueue: async () => {
      if (claimed) return { data: null };
      claimed = true;
      return { data: leased('queue-1', 'SLOW') };
    },
    renewDiscordQueueLease: async () => {
      throw new Error('lease service unavailable');
    },
    updateDiscordQueueStatus: async (_id, value) => {
      status = value;
    },
  };
  const dispatcher = {
    dispatch: async () => {
      await waitFor(() => logger.entries.error.some(
        ([message]) => message.includes('Queue lease renewal failed'),
      ), { timeoutMs: 1000 });
      return { success: true };
    },
  };
  const worker = new QueueWorker({
    apiService,
    dispatcher,
    logger,
    leaseRenewIntervalMs: 1,
    pollIntervalMs: 60_000,
  });

  worker.start();
  await waitFor(() => status === 'failed', { timeoutMs: 1000 });
  await worker.stop();

  assert.equal(status, 'failed');
});

test('QueueWorker stop is permanent and prevents rescheduling after an active poll', async () => {
  const logger = createLogger();
  let claims = 0;
  let releaseClaim;
  const apiService = {
    claimDiscordQueue: async () => {
      claims += 1;
      await new Promise((resolve) => { releaseClaim = resolve; });
      return { data: null };
    },
  };
  const worker = new QueueWorker({ apiService, dispatcher: {}, logger, pollIntervalMs: 1 });

  worker.start();
  await waitFor(() => claims === 1);
  const stopping = worker.stop({ timeoutMs: 100 });
  releaseClaim();
  await stopping;
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(claims, 1);
});

test('QueueWorker shutdown drains an item returned by an in-flight claim', async () => {
  const logger = createLogger();
  const events = [];
  let releaseClaim;
  let renewals = 0;
  const apiService = {
    claimDiscordQueue: async () => {
      events.push('claim-start');
      await new Promise((resolve) => { releaseClaim = resolve; });
      events.push('claim-finish');
      return { data: leased('queue-1', 'OK') };
    },
    renewDiscordQueueLease: async () => {
      renewals += 1;
      return { data: { leased_until: futureLease() } };
    },
    updateDiscordQueueStatus: async () => { events.push('ack'); },
  };
  const worker = new QueueWorker({
    apiService,
    dispatcher: {
      dispatch: async () => {
        events.push('dispatch');
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { success: true };
      },
    },
    logger,
    pollIntervalMs: 60_000,
    leaseRenewIntervalMs: 1,
  });

  worker.start();
  await waitFor(() => events.includes('claim-start'));
  const stopping = worker.stop({ timeoutMs: 100 });
  releaseClaim();
  const result = await stopping;

  assert.deepEqual(events, ['claim-start', 'claim-finish', 'dispatch', 'ack']);
  assert.deepEqual(result, { drained: true });
  assert.equal(renewals, 0);
});

test('QueueWorker shutdown stops extending an active lease while it drains', async () => {
  let releaseDispatch;
  let dispatchStarted = false;
  let renewals = 0;
  let claimed = false;
  const worker = new QueueWorker({
    apiService: {
      claimDiscordQueue: async () => {
        if (claimed) return { data: null };
        claimed = true;
        return { data: leased('queue-active', 'SLOW') };
      },
      renewDiscordQueueLease: async () => {
        renewals += 1;
        return { data: { leased_until: futureLease() } };
      },
      updateDiscordQueueStatus: async () => {},
    },
    dispatcher: {
      dispatch: async () => {
        dispatchStarted = true;
        await new Promise((resolve) => { releaseDispatch = resolve; });
        return { success: true };
      },
    },
    logger: createLogger(),
    pollIntervalMs: 60_000,
    leaseRenewIntervalMs: 20,
  });

  worker.start();
  await waitFor(() => dispatchStarted);
  const stopping = worker.stop({ timeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(renewals, 0);

  releaseDispatch();
  assert.deepEqual(await stopping, { drained: true });
});

test('QueueWorker shutdown ignores a late renewal response and remains bounded', async () => {
  let releaseDispatch;
  let releaseRenewal;
  let dispatchStarted = false;
  let renewalFinished = false;
  let renewalStarted = false;
  let renewals = 0;
  let claimed = false;
  const worker = new QueueWorker({
    apiService: {
      claimDiscordQueue: async () => {
        if (claimed) return { data: null };
        claimed = true;
        return { data: leased('queue-renewing', 'SLOW') };
      },
      renewDiscordQueueLease: async () => {
        renewals += 1;
        renewalStarted = true;
        await new Promise((resolve) => { releaseRenewal = resolve; });
        renewalFinished = true;
        return { data: { leased_until: futureLease() } };
      },
      updateDiscordQueueStatus: async () => {},
    },
    dispatcher: {
      dispatch: async () => {
        dispatchStarted = true;
        await new Promise((resolve) => { releaseDispatch = resolve; });
        return { success: true };
      },
    },
    logger: createLogger(),
    pollIntervalMs: 60_000,
    leaseRenewIntervalMs: 1,
  });

  worker.start();
  await waitFor(() => dispatchStarted && renewalStarted);
  const stopping = worker.stop({ timeoutMs: 100 });
  releaseDispatch();
  assert.deepEqual(await stopping, { drained: true });
  assert.equal(renewalFinished, false);
  assert.equal(renewals, 1);

  releaseRenewal();
  await waitFor(() => renewalFinished);
});

test('QueueWorker refuses new workflow steps inside the lease safety window', async () => {
  const item = leased('queue-expiring', 'MULTI_STEP');
  item.leased_until = new Date(Date.now() + 30).toISOString();
  let canContinue = null;
  let claimed = false;
  const worker = new QueueWorker({
    apiService: {
      claimDiscordQueue: async () => {
        if (claimed) return { data: null };
        claimed = true;
        return { data: item };
      },
      renewDiscordQueueLease: async () => ({ data: { leased_until: futureLease() } }),
      updateDiscordQueueStatus: async () => {},
    },
    dispatcher: {
      dispatch: async (_item, context) => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        canContinue = context.canContinue();
        return { success: false, reason: 'lease_window_closed' };
      },
    },
    logger: createLogger(),
    pollIntervalMs: 60_000,
    leaseRenewIntervalMs: 60_000,
    leaseSafetyMs: 10,
  });

  worker.start();
  await waitFor(() => canContinue !== null);
  await worker.stop({ timeoutMs: 50 });

  assert.equal(canContinue, false);
});

test('QueueWorker default shutdown deadline stays inside the active lease safety window', { timeout: 1000 }, async () => {
  let releaseWork;
  const worker = new QueueWorker({
    apiService: {},
    dispatcher: {},
    logger: createLogger(),
    leaseSafetyMs: 10,
  });
  worker.activeLease = {
    healthy: true,
    expiresAt: Date.now() + 60,
  };
  worker.currentWork = new Promise((resolve) => { releaseWork = resolve; });

  const startedAt = Date.now();
  const result = await worker.stop();
  const elapsedMs = Date.now() - startedAt;
  releaseWork();

  assert.deepEqual(result, { drained: false });
  assert.equal(elapsedMs >= 10, true);
  assert.equal(elapsedMs < 500, true);
});
