import { randomUUID } from 'node:crypto';

const CUSTOM_ID_PREFIX = 'nxs:';

/** Short-lived, process-local state for ephemeral Discord components. */
export class InteractionSessionStore {
  constructor({ ttlMs = 14 * 60 * 1000, maxEntries = 5000, createToken = randomUUID, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = Math.max(1, Number(maxEntries) || 5000);
    this.createToken = createToken;
    this.now = now;
    this.sessions = new Map();
  }

  create({
    commandName,
    userId,
    event,
    state = {},
    oneShot = false,
    connectionContext = null,
    connectionId = connectionContext?.connectionId ?? null,
    generation = connectionContext?.generation ?? null,
    guildId = connectionContext?.guildId ?? null,
  }) {
    this.prune();
    while (this.sessions.size >= this.maxEntries) {
      const oldestToken = this.sessions.keys().next().value;
      if (!oldestToken) break;
      this.sessions.delete(oldestToken);
    }
    const token = this.createToken().replaceAll('-', '');
    this.sessions.set(token, {
      commandName,
      userId: `${userId}`,
      event,
      state,
      oneShot,
      connectionId,
      generation,
      guildId,
      expiresAt: this.now() + this.ttlMs,
    });
    return `${CUSTOM_ID_PREFIX}${token}`;
  }

  resolve(customId, userId, connectionContext = null) {
    if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;
    const token = customId.slice(CUSTOM_ID_PREFIX.length);
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(token)) return null;
    const session = this.sessions.get(token);
    if (
      !session
      || session.expiresAt <= this.now()
      || session.userId !== `${userId}`
      || (connectionContext && (
        session.connectionId !== connectionContext.connectionId
        || session.generation !== connectionContext.generation
        || session.guildId !== connectionContext.guildId
      ))
    ) {
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

  /** Bind all new and resolved component state to one connection generation. */
  forConnection(connectionContext) {
    if (!connectionContext?.connectionId || !connectionContext?.generation || !connectionContext?.guildId) {
      throw new TypeError('A session scope requires connection, generation, and guild context.');
    }
    return {
      create: (options) => this.create({ ...options, connectionContext }),
      resolve: (customId, userId) => this.resolve(customId, userId, connectionContext),
      delete: (customId) => this.delete(customId),
      prune: () => this.prune(),
    };
  }
}
