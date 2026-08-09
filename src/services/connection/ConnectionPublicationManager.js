import { createHash } from 'node:crypto';
import { isConnectionCurrent } from './ConnectionContext.js';

export class ConnectionPublicationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ConnectionPublicationError';
    this.code = code;
  }
}

const fingerprint = (publication) => createHash('sha256')
  .update(JSON.stringify(publication))
  .digest('hex');

const bindingKey = (connection) => `${connection.connectionId}:${connection.generation}`;

const hasPublishedValue = (entry, keys) => keys.some((key) => (
  Object.hasOwn(entry, key) && entry[key] !== null && entry[key] !== undefined
));

const requireExplicitContext = (entry) => {
  const required = [
    ['application', ['applicationId', 'app_id']],
    ['generation', ['generation']],
    ['relay key', ['keyId', 'key_id']],
    ['capabilities', ['capabilities']],
  ];
  const missing = required.find(([, keys]) => !hasPublishedValue(entry, keys));
  if (missing) {
    throw new ConnectionPublicationError(
      'INCOMPLETE_CONNECTION_PUBLICATION',
      `A connection publication entry is missing explicit ${missing[0]} context.`,
    );
  }
};

/**
 * Validates complete connection snapshots before atomically publishing them to
 * the shared resolver. Invalid refreshes retain the prior snapshot; normal
 * connection expiry still makes that snapshot fail closed.
 */
export class ConnectionPublicationManager {
  constructor({
    source,
    resolver,
    applicationId,
    buildConnection,
    validateConnection = () => true,
    logger,
    refreshIntervalMs = 30_000,
    clock = Date.now,
    onAccepted = () => undefined,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {}) {
    if (typeof source?.read !== 'function') throw new TypeError('Connection publication source must implement read().');
    if (typeof resolver?.replace !== 'function') throw new TypeError('Connection publication manager requires a resolver.');
    if (typeof buildConnection !== 'function') throw new TypeError('Connection publication manager requires a builder.');
    if (typeof validateConnection !== 'function') {
      throw new TypeError('Connection publication validator must be a function.');
    }

    this.source = source;
    this.resolver = resolver;
    this.applicationId = `${applicationId ?? ''}`.trim();
    this.buildConnection = buildConnection;
    this.validateConnection = validateConnection;
    this.logger = logger;
    this.refreshIntervalMs = Number.isSafeInteger(refreshIntervalMs) && refreshIntervalMs > 0
      ? refreshIntervalMs
      : 30_000;
    this.clock = clock;
    this.onAccepted = onAccepted;
    this.schedule = schedule;
    this.cancel = cancel;

    this.timer = null;
    this.refreshPromise = null;
    this.started = false;
    this.stopped = false;
    this.lastFingerprint = null;
    this.lastRefreshSucceeded = null;
    this.lastRefreshedAt = null;
    this.failureCount = 0;
    this.highWaterByGuild = new Map();
    this.fencedGuilds = new Set();
    this.#seedFences(this.resolver.list?.({ includeInactive: true }) ?? []);
  }

  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.refresh();
    this.#scheduleNext();
  }

  refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.stopped) {
      return Promise.resolve({
        accepted: false,
        changed: false,
        errorCode: 'CONNECTION_PUBLICATION_MANAGER_STOPPED',
      });
    }

    const operation = this.#refresh().finally(() => {
      if (this.refreshPromise === operation) this.refreshPromise = null;
    });
    this.refreshPromise = operation;
    return operation;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = null;
    }
    await this.refreshPromise?.catch(() => undefined);
  }

  getHealthSnapshot() {
    return {
      configured: true,
      started: this.started,
      stopped: this.stopped,
      last_refresh_succeeded: this.lastRefreshSucceeded,
      last_refreshed_at: this.lastRefreshedAt,
      failure_count: this.failureCount,
      active_connections: this.resolver.listActive?.().length ?? 0,
    };
  }

  async #refresh() {
    try {
      const publication = await this.source.read();
      this.#observeCurrentFences();
      const publicationFingerprint = fingerprint(publication);
      if (publicationFingerprint === this.lastFingerprint) {
        this.#recordSuccess();
        return {
          accepted: true,
          changed: false,
          connectionCount: this.resolver.list?.({ includeInactive: true }).length ?? 0,
        };
      }

      const connections = this.#validate(publication);
      const previous = this.resolver.list?.({ includeInactive: true }) ?? [];
      this.resolver.replace(connections);
      try {
        await this.onAccepted(connections, previous);
      } catch (cause) {
        this.resolver.replace(previous);
        throw new ConnectionPublicationError(
          'CONNECTION_PUBLICATION_ACTIVATION_FAILED',
          'The validated connection publication could not be activated.',
          { cause },
        );
      }

      this.#acceptFences(connections);
      this.lastFingerprint = publicationFingerprint;
      this.#recordSuccess();
      this.logger?.info?.('Accepted connection publication snapshot', {
        connectionCount: connections.length,
      });
      return { accepted: true, changed: true, connectionCount: connections.length };
    } catch (error) {
      const errorCode = error?.code ?? 'INVALID_CONNECTION_PUBLICATION';
      this.lastRefreshSucceeded = false;
      this.lastRefreshedAt = new Date(this.clock()).toISOString();
      this.failureCount += 1;
      this.logger?.warn?.('Rejected connection publication snapshot; retaining last known good routes', {
        errorCode,
      });
      return { accepted: false, changed: false, errorCode };
    }
  }

  #validate(publication) {
    if (!Array.isArray(publication)) {
      throw new ConnectionPublicationError(
        'INVALID_CONNECTION_PUBLICATION',
        'A connection publication must be a complete array.',
      );
    }

    const connections = publication.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ConnectionPublicationError(
          'INVALID_CONNECTION_PUBLICATION',
          'Every connection publication entry must be an object.',
        );
      }
      requireExplicitContext(entry);
      try {
        return this.buildConnection(entry);
      } catch (cause) {
        throw new ConnectionPublicationError(
          cause?.code ?? 'INVALID_CONNECTION_PUBLICATION',
          'A connection publication entry is invalid.',
          { cause },
        );
      }
    });

    const seenBindings = new Set();
    const identityByConnection = new Map();
    const currentByGuild = new Map();
    const candidateHighWater = new Map();
    const now = this.clock();
    for (const connection of connections) {
      if (!this.applicationId || connection.applicationId !== this.applicationId) {
        throw new ConnectionPublicationError(
          'FOREIGN_DISCORD_APPLICATION',
          'A connection publication targets another Discord application.',
        );
      }

      const binding = bindingKey(connection);
      if (seenBindings.has(binding)) {
        throw new ConnectionPublicationError(
          'DUPLICATE_CONNECTION_BINDING',
          'A connection binding appears more than once in the publication.',
        );
      }
      seenBindings.add(binding);

      const identity = identityByConnection.get(connection.connectionId);
      if (identity && (identity.applicationId !== connection.applicationId
        || identity.guildId !== connection.guildId)) {
        throw new ConnectionPublicationError(
          'CONNECTION_IDENTITY_CONFLICT',
          'A connection identifier is bound to more than one Discord guild.',
        );
      }
      identityByConnection.set(connection.connectionId, connection);

      const candidate = candidateHighWater.get(connection.guildId);
      if (!candidate || connection.generation > candidate.generation) {
        candidateHighWater.set(connection.guildId, connection);
      } else if (connection.generation === candidate.generation
        && connection.connectionId !== candidate.connectionId) {
        throw new ConnectionPublicationError(
          'CONNECTION_GENERATION_CONFLICT',
          'One guild publication contains different connections at the same generation.',
        );
      }

      if (isConnectionCurrent(connection, now)) {
        if (currentByGuild.has(connection.guildId)) {
          throw new ConnectionPublicationError(
            'AMBIGUOUS_ACTIVE_CONNECTION',
            'A guild publication contains multiple current active connections.',
          );
        }
        currentByGuild.set(connection.guildId, connection);
      }
    }

    for (const [guildId, current] of currentByGuild) {
      const candidate = candidateHighWater.get(guildId);
      if (candidate && current.generation < candidate.generation) {
        throw new ConnectionPublicationError(
          'CONNECTION_STATE_ROLLBACK',
          'An older connection generation cannot remain active after a newer generation.',
        );
      }
      try {
        if (this.validateConnection(current) !== true) {
          throw new TypeError('Connection validation did not succeed.');
        }
      } catch (cause) {
        throw new ConnectionPublicationError(
          cause?.code ?? 'INVALID_CONNECTION_CREDENTIALS',
          'An active connection publication cannot be initialized.',
          { cause },
        );
      }
    }

    for (const [guildId, candidate] of candidateHighWater) {
      const accepted = this.highWaterByGuild.get(guildId);
      if (!accepted) continue;
      if (candidate.generation < accepted.generation) {
        throw new ConnectionPublicationError(
          'CONNECTION_GENERATION_ROLLBACK',
          'A connection publication attempts to lower an accepted generation.',
        );
      }
      if (candidate.generation === accepted.generation
        && candidate.connectionId !== accepted.connectionId) {
        throw new ConnectionPublicationError(
          'CONNECTION_GENERATION_CONFLICT',
          'A connection publication changes identity without advancing generation.',
        );
      }
      if (this.fencedGuilds.has(guildId)
        && currentByGuild.has(guildId)
        && candidate.generation <= accepted.generation) {
        throw new ConnectionPublicationError(
          'REVOKED_CONNECTION_GENERATION',
          'A fenced connection generation cannot be reactivated.',
        );
      }
    }

    return connections;
  }

  #seedFences(connections) {
    const currentGuilds = new Set();
    const now = this.clock();
    for (const connection of connections) {
      this.#advanceHighWater(connection);
      if (isConnectionCurrent(connection, now)) currentGuilds.add(connection.guildId);
    }
    for (const guildId of this.highWaterByGuild.keys()) {
      if (!currentGuilds.has(guildId)) this.fencedGuilds.add(guildId);
    }
  }

  #observeCurrentFences() {
    const currentGuilds = new Set();
    const now = this.clock();
    for (const connection of this.resolver.list?.({ includeInactive: true }) ?? []) {
      if (isConnectionCurrent(connection, now)) currentGuilds.add(connection.guildId);
    }
    for (const guildId of this.highWaterByGuild.keys()) {
      if (!currentGuilds.has(guildId)) this.fencedGuilds.add(guildId);
    }
  }

  #acceptFences(connections) {
    const currentByGuild = new Map();
    const now = this.clock();
    for (const connection of connections) {
      this.#advanceHighWater(connection);
      if (isConnectionCurrent(connection, now)) currentByGuild.set(connection.guildId, connection);
    }

    for (const guildId of this.highWaterByGuild.keys()) {
      const current = currentByGuild.get(guildId);
      if (!current) {
        this.fencedGuilds.add(guildId);
        continue;
      }
      const highWater = this.highWaterByGuild.get(guildId);
      if (current.generation >= highWater.generation) this.fencedGuilds.delete(guildId);
    }
  }

  #advanceHighWater(connection) {
    const accepted = this.highWaterByGuild.get(connection.guildId);
    if (!accepted || connection.generation > accepted.generation) {
      this.highWaterByGuild.set(connection.guildId, {
        connectionId: connection.connectionId,
        generation: connection.generation,
      });
    }
  }

  #recordSuccess() {
    this.lastRefreshSucceeded = true;
    this.lastRefreshedAt = new Date(this.clock()).toISOString();
    this.failureCount = 0;
  }

  #scheduleNext() {
    if (this.stopped || this.timer) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.refresh().finally(() => this.#scheduleNext());
    }, this.refreshIntervalMs);
    this.timer?.unref?.();
  }
}
