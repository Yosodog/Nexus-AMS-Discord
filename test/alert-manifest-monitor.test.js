import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertManifestMonitor } from '../src/services/AlertManifestMonitor.js';
import { QueueWorker } from '../src/services/QueueWorker.js';
import { createLogger } from './helpers.js';

const validManifest = { contract_version: 1, capabilities: { queue_lanes: true } };

const registry = {
  verifyManifest: (manifest) => (manifest?.contract_version === 1
    ? { valid: true, contract_version: 1 }
    : { valid: false, reason: 'contract_mismatch' }),
};

const serverError = () => Object.assign(new Error('Request failed with status code 500'), {
  code: 'ERR_BAD_RESPONSE',
  response: { status: 500 },
});

function createScheduler() {
  const pending = [];
  return {
    pending,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs };
      pending.push(timer);
      return timer;
    },
    cancel: (timer) => {
      const index = pending.indexOf(timer);
      if (index !== -1) pending.splice(index, 1);
    },
    async runNext() {
      const timer = pending.shift();
      assert.ok(timer, 'expected a scheduled retry');
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
      return timer.delayMs;
    },
  };
}

function createMonitor(responses, overrides = {}) {
  const scheduler = createScheduler();
  const logger = createLogger();
  const readyEvents = [];
  let calls = 0;
  const monitor = new AlertManifestMonitor({
    apiService: {
      getAlertRendererManifest: async () => {
        const next = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        if (next instanceof Error) throw next;
        return next;
      },
    },
    registry,
    logger,
    onReady: (event) => readyEvents.push(event),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    ...overrides,
  });
  return { monitor, scheduler, logger, readyEvents, calls: () => calls };
}

test('AlertManifestMonitor enables lanes immediately when the manifest verifies at boot', async () => {
  const { monitor, scheduler, logger, readyEvents } = createMonitor([validManifest]);

  assert.equal(await monitor.start(), true);
  assert.equal(monitor.lanesEnabled, true);
  assert.equal(scheduler.pending.length, 0);
  assert.equal(readyEvents.length, 1);
  assert.equal(readyEvents[0].recovered, false);
  assert.equal(logger.entries.error.length, 0);
});

test('AlertManifestMonitor retries a failed boot fetch with capped backoff and recovers', async () => {
  const { monitor, scheduler, logger, readyEvents, calls } = createMonitor(
    [serverError(), serverError(), serverError(), validManifest],
    { initialRetryMs: 15_000, maxRetryMs: 40_000 },
  );

  assert.equal(await monitor.start(), false);
  assert.equal(readyEvents.length, 0);
  assert.equal(logger.entries.error[0][1].status, 500);

  assert.equal(await scheduler.runNext(), 15_000);
  assert.equal(await scheduler.runNext(), 30_000);
  assert.equal(await scheduler.runNext(), 40_000);

  assert.equal(calls(), 4);
  assert.equal(monitor.lanesEnabled, true);
  assert.equal(scheduler.pending.length, 0);
  assert.equal(readyEvents.length, 1);
  assert.equal(readyEvents[0].recovered, true);
  assert.deepEqual(monitor.getHealthSnapshot(), {
    verified: true,
    lanes_enabled: true,
    failure_count: 3,
    retry_scheduled: false,
  });
});

test('AlertManifestMonitor keeps retrying a manifest that does not verify', async () => {
  const { monitor, scheduler, readyEvents } = createMonitor([{ contract_version: 99 }, validManifest]);

  assert.equal(await monitor.start(), false);
  assert.equal(monitor.status.reason, 'contract_mismatch');
  await scheduler.runNext();

  assert.equal(monitor.lanesEnabled, true);
  assert.equal(readyEvents.length, 1);
});

test('AlertManifestMonitor does not enable lanes for a manifest without queue lane capability', async () => {
  const { monitor, scheduler, readyEvents } = createMonitor([{ contract_version: 1, capabilities: {} }]);

  assert.equal(await monitor.start(), false);
  assert.equal(monitor.status.valid, true);
  assert.equal(readyEvents.length, 0);
  assert.equal(scheduler.pending.length, 1);
});

test('AlertManifestMonitor stops retrying after shutdown', async () => {
  const { monitor, scheduler, calls } = createMonitor([serverError()]);

  await monitor.start();
  assert.equal(scheduler.pending.length, 1);
  await monitor.stop();

  assert.equal(scheduler.pending.length, 0);
  assert.equal(await monitor.check(), false);
  assert.equal(calls(), 1);
});

test('QueueWorker enable() starts polling a lane that booted disabled', async () => {
  const logger = createLogger();
  let claims = 0;
  const worker = new QueueWorker({
    apiService: {
      claimDiscordQueue: async () => {
        claims += 1;
        return { data: null };
      },
    },
    dispatcher: {},
    logger,
    lane: 'alerts',
    enabled: false,
    pollIntervalMs: 10_000,
  });

  worker.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claims, 0);

  worker.enable();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(claims, 1);
  assert.ok(logger.entries.info.some(([message]) => message === 'Starting leased Nexus queue worker'));

  await worker.stop();
});

test('QueueWorker enable() before start() defers polling until start()', async () => {
  let claims = 0;
  const worker = new QueueWorker({
    apiService: { claimDiscordQueue: async () => { claims += 1; return { data: null }; } },
    dispatcher: {},
    logger: createLogger(),
    lane: 'alerts',
    enabled: false,
    pollIntervalMs: 10_000,
  });

  worker.enable();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(claims, 0);

  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(claims, 1);

  await worker.stop();
});
