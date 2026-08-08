import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessHealth, writeHealthSnapshot } from '../src/services/ProcessHealth.js';
import { runHealthcheck, validateHealthSnapshot } from '../src/healthcheck.js';
import { createLogger } from './helpers.js';

const queueReady = {
  started: true,
  stopped: false,
  polling: false,
  active_item: false,
  lease_healthy: null,
  backoff_attempts: 0,
};

test('ProcessHealth publishes a bounded lifecycle without tenant credentials', async () => {
  const snapshots = [];
  const logger = createLogger();
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  let heartbeat;
  let clearedTimer;
  let timestamp = Date.parse('2026-08-07T05:00:00.000Z');
  const health = new ProcessHealth({
    healthFile: '/runtime/process-health.json',
    intervalMs: 15_000,
    staleAfterMs: 45_000,
    build: { commit: 'abc123', release: 'release-1' },
    queueStatus: () => queueReady,
    scopeStatus: () => ({ guild_configured: true }),
    logger,
    now: () => {
      const value = new Date(timestamp);
      timestamp += 1_000;
      return value;
    },
    writeSnapshot: async (healthFile, snapshot) => {
      assert.equal(healthFile, '/runtime/process-health.json');
      snapshots.push(snapshot);
    },
    setIntervalFn: (handler, delay) => {
      assert.equal(delay, 15_000);
      heartbeat = handler;
      return timer;
    },
    clearIntervalFn: (receivedTimer) => {
      clearedTimer = receivedTimer;
    },
  });

  await health.start();
  await health.markReady();
  await heartbeat();
  await health.markStopping('SIGTERM');
  await health.stop({ signal: 'SIGTERM', drained: true });

  assert.equal(timer.unrefCalled, true);
  assert.equal(clearedTimer, timer);
  assert.deepEqual(snapshots.map(({ status }) => status), [
    'starting',
    'ready',
    'ready',
    'stopping',
    'stopped',
  ]);
  assert.deepEqual(snapshots[1].build, {
    version: '0.1.0',
    commit: 'abc123',
    release: 'release-1',
  });
  assert.deepEqual(snapshots[1].scope, { guild_configured: true });
  assert.deepEqual(snapshots[1].queue, queueReady);
  assert.deepEqual(snapshots.at(-1).shutdown, { signal: 'SIGTERM', drained: true });

  const serialized = JSON.stringify(snapshots);
  assert.doesNotMatch(serialized, /DISCORD_BOT_TOKEN|NEXUS_API_KEY|guild_id|lease_token/i);
});

test('Discord process health file is private, atomic, and fail-closed when stale', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-discord-health-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const healthFile = path.join(tempDir, 'nested', 'process-health.json');
  const heartbeatAt = '2026-08-07T05:00:00.000Z';
  const snapshot = {
    schema_version: 1,
    service: 'nexus-ams-discord',
    status: 'ready',
    heartbeat_at: heartbeatAt,
    stale_after_ms: 45_000,
    build: { version: '0.1.0', commit: 'abc123', release: 'release-1' },
    scope: { guild_configured: true },
    queue: queueReady,
  };

  await writeHealthSnapshot(healthFile, snapshot);

  assert.deepEqual(JSON.parse(await fs.readFile(healthFile, 'utf8')), snapshot);
  assert.equal((await fs.stat(healthFile)).mode & 0o777, 0o600);
  assert.deepEqual(
    await runHealthcheck({ healthFile, now: Date.parse(heartbeatAt) + 10_000 }),
    { healthy: true, reason: 'ready' },
  );
  assert.deepEqual(
    validateHealthSnapshot(snapshot, { now: Date.parse(heartbeatAt) + 60_000 }),
    { healthy: false, reason: 'stale_heartbeat' },
  );
  assert.deepEqual(
    validateHealthSnapshot({ ...snapshot, status: 'stopping' }),
    { healthy: false, reason: 'not_ready' },
  );
  assert.deepEqual(
    validateHealthSnapshot({ ...snapshot, queue: { ...queueReady, started: false } }),
    { healthy: false, reason: 'runtime_not_ready' },
  );
  assert.deepEqual(
    validateHealthSnapshot({ ...snapshot, queue: { ...queueReady, stopped: true } }),
    { healthy: false, reason: 'runtime_not_ready' },
  );
  assert.deepEqual(
    validateHealthSnapshot({ ...snapshot, queue: { ...queueReady, lease_healthy: false } }),
    { healthy: false, reason: 'runtime_not_ready' },
  );
  assert.deepEqual(
    validateHealthSnapshot({ ...snapshot, scope: { guild_configured: false } }),
    { healthy: false, reason: 'runtime_not_ready' },
  );
  assert.deepEqual(
    validateHealthSnapshot({ ...snapshot, heartbeat_at: 'not-a-date' }),
    { healthy: false, reason: 'invalid_heartbeat' },
  );
  assert.deepEqual(
    validateHealthSnapshot(snapshot, { now: Date.parse(heartbeatAt) - 60_000 }),
    { healthy: false, reason: 'future_heartbeat' },
  );
});

test('process health config defaults invalid values and sanitizes build identifiers', async (t) => {
  const keys = [
    'PROCESS_HEALTH_FILE',
    'PROCESS_HEALTH_INTERVAL_MS',
    'PROCESS_HEALTH_STALE_AFTER_MS',
    'BUILD_COMMIT',
    'NEXUS_RELEASE_ID',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.PROCESS_HEALTH_FILE = '';
  process.env.PROCESS_HEALTH_INTERVAL_MS = '0';
  process.env.PROCESS_HEALTH_STALE_AFTER_MS = 'invalid';
  process.env.BUILD_COMMIT = 'secret\ncommit';
  process.env.NEXUS_RELEASE_ID = 'release-2026.08.07';

  const { config } = await import(`../src/utils/config.js?health=${Date.now()}`);

  assert.equal(config.processHealth.file, path.resolve(process.cwd(), 'data/process-health.json'));
  assert.equal(config.processHealth.intervalMs, 15_000);
  assert.equal(config.processHealth.staleAfterMs, 45_000);
  assert.equal(config.build.commit, 'unknown');
  assert.equal(config.build.release, 'release-2026.08.07');
});
