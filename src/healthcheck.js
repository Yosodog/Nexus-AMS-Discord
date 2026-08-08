import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HEALTH_SCHEMA_VERSION, SERVICE_NAME } from './processHealthContract.js';

const DEFAULT_STALE_AFTER_MS = 45_000;
const FUTURE_TOLERANCE_MS = 30_000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function validateHealthSnapshot(snapshot, options = {}) {
  const now = options.now ?? Date.now();
  const staleAfterMs = positiveInteger(
    options.staleAfterMs ?? snapshot?.stale_after_ms,
    DEFAULT_STALE_AFTER_MS,
  );

  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { healthy: false, reason: 'invalid_snapshot' };
  }

  if (snapshot.schema_version !== HEALTH_SCHEMA_VERSION || snapshot.service !== SERVICE_NAME) {
    return { healthy: false, reason: 'unsupported_contract' };
  }

  if (snapshot.status !== 'ready') {
    return { healthy: false, reason: 'not_ready' };
  }

  if (
    typeof snapshot.build?.version !== 'string'
    || typeof snapshot.build?.commit !== 'string'
    || typeof snapshot.build?.release !== 'string'
  ) {
    return { healthy: false, reason: 'missing_build_metadata' };
  }

  if (
    snapshot.scope?.guild_configured !== true
    || snapshot.queue?.started !== true
    || snapshot.queue?.stopped !== false
    || snapshot.queue?.lease_healthy === false
  ) {
    return { healthy: false, reason: 'runtime_not_ready' };
  }

  const heartbeatAt = Date.parse(snapshot.heartbeat_at);
  if (!Number.isFinite(heartbeatAt)) {
    return { healthy: false, reason: 'invalid_heartbeat' };
  }

  if (heartbeatAt > now + FUTURE_TOLERANCE_MS) {
    return { healthy: false, reason: 'future_heartbeat' };
  }

  if (now - heartbeatAt > staleAfterMs) {
    return { healthy: false, reason: 'stale_heartbeat' };
  }

  return { healthy: true, reason: 'ready' };
}

export async function runHealthcheck(options = {}) {
  const healthFile = options.healthFile
    || process.env.PROCESS_HEALTH_FILE
    || path.resolve(process.cwd(), 'data/process-health.json');

  try {
    const contents = await fs.readFile(healthFile, 'utf8');
    return validateHealthSnapshot(JSON.parse(contents), {
      now: options.now,
      staleAfterMs: options.staleAfterMs || process.env.PROCESS_HEALTH_STALE_AFTER_MS,
    });
  } catch {
    return { healthy: false, reason: 'unavailable' };
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = await runHealthcheck();
  if (result.healthy) {
    process.stdout.write('healthy\n');
  } else {
    process.stderr.write(`unhealthy: ${result.reason}\n`);
    process.exitCode = 1;
  }
}
