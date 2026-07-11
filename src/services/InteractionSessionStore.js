import { randomUUID } from 'node:crypto';

const CUSTOM_ID_PREFIX = 'nxs:';

/** Short-lived, process-local state for ephemeral Discord components. */
export class InteractionSessionStore {
  constructor({ ttlMs = 14 * 60 * 1000, createToken = randomUUID, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.createToken = createToken;
    this.now = now;
    this.sessions = new Map();
  }

  create({ commandName, userId, event, state = {}, oneShot = false }) {
    this.prune();
    const token = this.createToken().replaceAll('-', '');
    this.sessions.set(token, {
      commandName,
      userId: `${userId}`,
      event,
      state,
      oneShot,
      expiresAt: this.now() + this.ttlMs,
    });
    return `${CUSTOM_ID_PREFIX}${token}`;
  }

  resolve(customId, userId) {
    if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;
    const token = customId.slice(CUSTOM_ID_PREFIX.length);
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(token)) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= this.now() || session.userId !== `${userId}`) {
      this.sessions.delete(token);
      return null;
    }
    if (session.oneShot) this.sessions.delete(token);
    return session;
  }

  delete(customId) {
    if (typeof customId === 'string' && customId.startsWith(CUSTOM_ID_PREFIX)) {
      this.sessions.delete(customId.slice(CUSTOM_ID_PREFIX.length));
    }
  }

  prune() {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}
