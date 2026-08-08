import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { HEALTH_SCHEMA_VERSION, SERVICE_NAME } from '../processHealthContract.js';

const require = createRequire(import.meta.url);
const packageMetadata = require('../../package.json');

export async function writeHealthSnapshot(healthFile, snapshot) {
  const directory = path.dirname(healthFile);
  const temporaryFile = `${healthFile}.${process.pid}.${randomUUID()}.tmp`;

  await fs.mkdir(directory, { recursive: true });

  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(snapshot)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryFile, healthFile);
  } finally {
    await fs.rm(temporaryFile, { force: true });
  }
}

export class ProcessHealth {
  constructor({
    healthFile,
    intervalMs,
    staleAfterMs,
    build,
    queueStatus,
    scopeStatus,
    logger,
    now = () => new Date(),
    writeSnapshot = writeHealthSnapshot,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.healthFile = healthFile;
    this.intervalMs = intervalMs;
    this.staleAfterMs = staleAfterMs;
    this.build = build;
    this.queueStatus = queueStatus;
    this.scopeStatus = scopeStatus;
    this.logger = logger;
    this.now = now;
    this.writeSnapshot = writeSnapshot;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.startedAt = this.now().toISOString();
    this.state = 'starting';
    this.shutdown = null;
    this.heartbeatTimer = null;
    this.writeChain = Promise.resolve();
  }

  async start() {
    await this.#publish();
    this.heartbeatTimer = this.setIntervalFn(
      () => this.#publish().catch(() => {
        this.logger.error('Failed to write Discord process heartbeat', {
          errorCode: 'HEALTH_WRITE_FAILED',
        });
      }),
      this.intervalMs,
    );
    this.heartbeatTimer.unref?.();
  }

  async markReady() {
    this.state = 'ready';
    await this.#publish();
  }

  async markStopping(signal) {
    this.state = 'stopping';
    this.shutdown = { signal };
    await this.#publish();
  }

  async stop({ signal, drained }) {
    this.#clearHeartbeat();
    this.state = drained ? 'stopped' : 'degraded';
    this.shutdown = { signal, drained };
    await this.#publish();
  }

  async failStartup() {
    this.#clearHeartbeat();
    this.state = 'failed';
    await this.#publish();
  }

  #snapshot() {
    return {
      schema_version: HEALTH_SCHEMA_VERSION,
      service: SERVICE_NAME,
      status: this.state,
      pid: process.pid,
      started_at: this.startedAt,
      heartbeat_at: this.now().toISOString(),
      stale_after_ms: this.staleAfterMs,
      build: {
        version: packageMetadata.version,
        commit: this.build.commit,
        release: this.build.release,
      },
      scope: this.scopeStatus(),
      queue: this.queueStatus(),
      ...(this.shutdown ? { shutdown: this.shutdown } : {}),
    };
  }

  #publish() {
    const snapshot = this.#snapshot();
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.writeSnapshot(this.healthFile, snapshot));

    return this.writeChain;
  }

  #clearHeartbeat() {
    if (!this.heartbeatTimer) {
      return;
    }

    this.clearIntervalFn(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
