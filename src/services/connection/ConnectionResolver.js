import {
  CONNECTION_MODES,
  CONNECTION_STATES,
  commandCapability,
  createConnectionContext,
  isConnectionCurrent,
  normalizeConnectionMode,
} from './ConnectionContext.js';

export class ConnectionResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConnectionResolutionError';
    this.code = code;
    this.details = details;
  }
}
const normalizedSnowflake = (value) => `${value ?? ''}`.trim();

/**
 * Resolves one explicit Discord application/guild binding. The resolver is
 * deliberately in-memory: Cloud publication and persistence belong to the
 * control plane, while this object is the bot's fail-closed read model.
 */
export class ConnectionResolver {
  constructor({
    mode = CONNECTION_MODES.DEDICATED,
    applicationId = null,
    dedicatedContext = null,
    connections = [],
    clock = Date.now,
    logger = null,
  } = {}) {
    this.mode = normalizeConnectionMode(mode);
    this.applicationId = applicationId ? normalizedSnowflake(applicationId) : null;
    this.clock = clock;
    this.logger = logger;
    this.connections = [];
    if (dedicatedContext) this.replace([dedicatedContext]);
    if (connections.length > 0) this.replace(connections);
  }

  replace(connections = []) {
    if (!Array.isArray(connections)) throw new TypeError('Connection resolver entries must be an array.');
    this.connections = connections.map((connection) => (
      connection?.connectionId ? createConnectionContext(connection) : connection
    ));
    return this.snapshot();
  }

  add(connection) {
    const normalized = connection?.connectionId ? createConnectionContext(connection) : connection;
    this.connections.push(normalized);
    return normalized;
  }

  remove(connectionId) {
    const before = this.connections.length;
    this.connections = this.connections.filter((connection) => connection.connectionId !== connectionId);
    return this.connections.length !== before;
  }

  list({ includeInactive = false } = {}) {
    const now = this.clock();
    return this.connections.filter((connection) => includeInactive || isConnectionCurrent(connection, now));
  }

  listActive() {
    return this.list();
  }

  resolve({ applicationId = this.applicationId, guildId, commandName = null } = {}) {
    const requestedGuild = normalizedSnowflake(guildId);
    const requestedApplication = normalizedSnowflake(applicationId);
    if (!requestedGuild) {
      throw new ConnectionResolutionError('MISSING_GUILD', 'A Discord guild is required to resolve Nexus.');
    }

    const guildMatches = this.connections.filter((connection) => connection.guildId === requestedGuild);
    const applicationMatches = guildMatches.filter((connection) => (
      !requestedApplication || connection.applicationId === requestedApplication
    ));

    if (requestedApplication && guildMatches.length > 0 && applicationMatches.length === 0) {
      throw new ConnectionResolutionError('FOREIGN_APPLICATION', 'The Discord application is not trusted for this guild.', {
        guildId: requestedGuild,
      });
    }
    if (applicationMatches.length === 0) {
      throw new ConnectionResolutionError('CONNECTION_NOT_FOUND', 'No Nexus connection is active for this Discord guild.', {
        guildId: requestedGuild,
      });
    }
    if (applicationMatches.length > 1) {
      throw new ConnectionResolutionError('AMBIGUOUS_CONNECTION', 'Multiple Nexus connections match this Discord guild.', {
        guildId: requestedGuild,
      });
    }

    const [connection] = applicationMatches;
    if (connection.state !== CONNECTION_STATES.ACTIVE) {
      throw new ConnectionResolutionError('CONNECTION_UNAVAILABLE', 'The Nexus connection is not active.', {
        connectionId: connection.connectionId,
      });
    }
    if (!isConnectionCurrent(connection, this.clock())) {
      throw new ConnectionResolutionError('STALE_CONNECTION', 'The Nexus connection publication has expired.', {
        connectionId: connection.connectionId,
        generation: connection.generation,
      });
    }
    if (commandName && !commandCapability(connection, commandName)) {
      throw new ConnectionResolutionError('CAPABILITY_UNAVAILABLE', 'This Nexus installation does not advertise that command.', {
        connectionId: connection.connectionId,
        commandName,
      });
    }
    return connection;
  }

  resolveInteraction(interaction, { commandName = interaction?.commandName ?? null, applicationId = null } = {}) {
    return this.resolve({
      applicationId: applicationId ?? this.applicationId,
      guildId: interaction?.guildId,
      commandName,
    });
  }

  resolveDelivery(item = {}) {
    const connectionId = `${item.connection_id ?? item.connectionId ?? ''}`.trim().toLowerCase();
    const applicationId = normalizedSnowflake(item.app_id ?? item.application_id ?? item.applicationId);
    const guildId = normalizedSnowflake(item.guild_id ?? item.guildId);
    const generation = Number(item.generation ?? item.connection_generation ?? NaN);

    if (this.mode === CONNECTION_MODES.DEDICATED && !connectionId && !Number.isFinite(generation)) {
      return this.resolve({ guildId: guildId || this.connections[0]?.guildId });
    }
    if (!connectionId || !Number.isSafeInteger(generation) || generation < 1) {
      throw new ConnectionResolutionError('MISSING_DELIVERY_BINDING', 'Queue delivery is missing its connection binding.');
    }

    const connection = this.resolve({ applicationId, guildId });
    if (connection.connectionId !== connectionId) {
      throw new ConnectionResolutionError('FOREIGN_CONNECTION', 'Queue delivery belongs to another connection.', {
        connectionId,
      });
    }
    if (connection.generation !== generation) {
      throw new ConnectionResolutionError('STALE_GENERATION', 'Queue delivery uses a stale connection generation.', {
        connectionId,
        expectedGeneration: connection.generation,
        receivedGeneration: generation,
      });
    }
    return connection;
  }

  diagnostics() {
    const now = this.clock();
    return {
      mode: this.mode,
      application_id: this.applicationId,
      active_connections: this.connections.filter((connection) => isConnectionCurrent(connection, now)).length,
      stale_connections: this.connections.filter((connection) => (
        connection.state === CONNECTION_STATES.ACTIVE && !isConnectionCurrent(connection, now)
      )).length,
      suspended_connections: this.connections.filter((connection) => connection.state === CONNECTION_STATES.SUSPENDED).length,
      revoked_connections: this.connections.filter((connection) => connection.state === CONNECTION_STATES.REVOKED).length,
      connections: this.connections.map((connection) => ({
        connection_id: connection.connectionId,
        application_id: connection.applicationId,
        guild_id: connection.guildId,
        generation: connection.generation,
        protocol_version: connection.protocolVersion,
        key_id: connection.keyId,
        state: connection.state,
        stale: !isConnectionCurrent(connection, now),
        capability_count: Object.keys(connection.capabilities?.commands ?? {}).length
          || (Array.isArray(connection.capabilities?.commands) ? connection.capabilities.commands.length : 0),
      })),
    };
  }

  snapshot() {
    return this.connections.map((connection) => ({
      connectionId: connection.connectionId,
      applicationId: connection.applicationId,
      guildId: connection.guildId,
      generation: connection.generation,
      state: connection.state,
    }));
  }
}
