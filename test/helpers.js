import assert from 'node:assert/strict';

export function createLogger() {
  const entries = { info: [], warn: [], error: [], debug: [] };

  return {
    entries,
    info: (...args) => entries.info.push(args),
    warn: (...args) => entries.warn.push(args),
    error: (...args) => entries.error.push(args),
    debug: (...args) => entries.debug.push(args),
  };
}

export function createEventClient() {
  const handlers = new Map();

  return {
    handlers,
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  };
}

export function embedJson(payload, index = 0) {
  const embed = payload?.embeds?.[index];
  return embed?.toJSON ? embed.toJSON() : embed;
}

export async function waitFor(predicate, { timeoutMs = 200, intervalMs = 5 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  assert.fail('Timed out waiting for condition');
}
