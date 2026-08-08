import { createHash } from 'node:crypto';
import { validateNexusEndpoint } from './EndpointGuard.js';

export const CONNECTION_MODES = Object.freeze({
  DEDICATED: 'dedicated',
  OFFICIAL_SHARED: 'official-shared',
  // Compatibility symbol; all emitted contexts use OFFICIAL_SHARED.
  SHARED: 'official-shared',
});

export const CONNECTION_STATES = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REVOKED: 'revoked',
});

const SNOWFLAKE = /^\d{17,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export class ConnectionContextError extends TypeError {
  constructor(message, code = 'INVALID_CONNECTION_CONTEXT') {
    super(message);
    this.name = 'ConnectionContextError';
    this.code = code;
  }
}

export const normalizeConnectionMode = (value) => {
  const normalized = `${value ?? ''}`.trim().toLowerCase();
  if (['official-shared', 'shared', 'multi', 'multi-alliance'].includes(normalized)) {
    return CONNECTION_MODES.OFFICIAL_SHARED;
  }
  return CONNECTION_MODES.DEDICATED;
};

export const isOfficialSharedMode = (value) => normalizeConnectionMode(value) === CONNECTION_MODES.OFFICIAL_SHARED;

const requiredSnowflake = (value, field) => {
  const normalized = `${value ?? ''}`.trim();
  if (!SNOWFLAKE.test(normalized)) throw new ConnectionContextError(`${field} must be a Discord snowflake.`);
  return normalized;
};

const requiredUuid = (value, field) => {
  const normalized = `${value ?? ''}`.trim().toLowerCase();
  if (!UUID.test(normalized)) throw new ConnectionContextError(`${field} must be a canonical UUID.`);
  return normalized;
};

const safeCapabilities = (value) => {
  if (value === undefined || value === null) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConnectionContextError('Connection capabilities must be an object.');
  }
  const copy = structuredClone(value);
  return Object.freeze(copy);
};

export const contextKey = ({ connectionId, generation }) => `${connectionId}:${generation}`;

export const connectionBinding = (context) => ({
  connectionId: context.connectionId,
  applicationId: context.applicationId,
  guildId: context.guildId,
  generation: context.generation,
});

export const createConnectionContext = (input = {}) => {
  const mode = normalizeConnectionMode(input.mode);
  const protocolVersion = Number(input.protocolVersion ?? input.relayProtocolVersion ?? 1);
  if (![1, 2].includes(protocolVersion)) {
    throw new ConnectionContextError('Connection relay protocol must be version 1 or 2.');
  }
  const generation = Number(input.generation ?? 1);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ConnectionContextError('Connection generation must be a positive safe integer.');
  }
  const keyId = `${input.keyId ?? (protocolVersion === 1 ? 'legacy-v1' : '')}`.trim().toLowerCase();
  if (!KEY_ID.test(keyId)) throw new ConnectionContextError('Connection keyId is invalid.');

  const context = {
    mode,
    protocolVersion,
    applicationId: requiredSnowflake(input.applicationId ?? input.appId, 'applicationId'),
    appId: requiredSnowflake(input.applicationId ?? input.appId, 'applicationId'),
    guildId: requiredSnowflake(input.guildId, 'guildId'),
    connectionId: requiredUuid(input.connectionId, 'connectionId'),
    generation,
    keyId,
    state: input.state ?? CONNECTION_STATES.ACTIVE,
    endpointOrigin: input.endpointOrigin ?? input.baseUrl ?? null,
    capabilities: safeCapabilities(input.capabilities),
    expiresAt: input.expiresAt ?? null,
    acceptedAt: input.acceptedAt ?? null,
    apiService: input.apiService ?? null,
    relaySigner: input.relaySigner ?? null,
    serviceOptions: input.serviceOptions ?? null,
    source: input.source ?? mode,
  };

  if (!Object.values(CONNECTION_STATES).includes(context.state)) {
    throw new ConnectionContextError('Connection state is not supported.');
  }
  if (context.expiresAt !== null && !Number.isFinite(Date.parse(context.expiresAt))) {
    throw new ConnectionContextError('Connection expiresAt must be an RFC 3339 timestamp.');
  }
  if (mode === CONNECTION_MODES.OFFICIAL_SHARED && context.expiresAt === null) {
    throw new ConnectionContextError('Shared connection publications require an expiry timestamp.', 'MISSING_EXPIRY');
  }
  if (mode === CONNECTION_MODES.OFFICIAL_SHARED && !context.endpointOrigin) {
    throw new ConnectionContextError('Shared connection publications require an endpoint.', 'MISSING_ENDPOINT');
  }
  if (mode === CONNECTION_MODES.OFFICIAL_SHARED) {
    try {
      context.endpointOrigin = validateNexusEndpoint(context.endpointOrigin, { shared: true });
    } catch (error) {
      throw new ConnectionContextError(error.message, 'INVALID_ENDPOINT');
    }
  }
  if (mode === CONNECTION_MODES.OFFICIAL_SHARED && protocolVersion !== 2) {
    throw new ConnectionContextError('Shared connections require relay protocol v2.');
  }
  return Object.freeze(context);
};

export const isConnectionCurrent = (context, now = Date.now()) => (
  context?.state === CONNECTION_STATES.ACTIVE
  && (context.expiresAt === null || Date.parse(context.expiresAt) > now)
);

export const commandCapability = (context, commandName) => {
  const commands = context?.capabilities?.commands
    ?? context?.capabilities?.supported_commands
    ?? context?.capabilities?.http_commands;
  if (commands === undefined || commands === null) {
    return context?.mode === CONNECTION_MODES.DEDICATED;
  }
  if (Array.isArray(commands)) return commands.includes(commandName);
  if (typeof commands === 'object') return commands[commandName] !== undefined && commands[commandName] !== false;
  return false;
};

export const createDeliveryContext = (context, item = {}) => {
  if (!context?.connectionId || !context?.generation) {
    throw new ConnectionContextError('Delivery context requires a resolved connection.', 'MISSING_CONNECTION');
  }
  const deliveryId = `${item.delivery_id ?? item.deliveryId ?? item.id ?? ''}`.trim();
  const dedupeKey = `${item.dedupe_key ?? item.dedupeKey ?? deliveryId}`.trim();
  if (!deliveryId || !dedupeKey) {
    throw new ConnectionContextError('Delivery context requires delivery and dedupe identifiers.', 'INVALID_DELIVERY');
  }
  return Object.freeze({
    connectionId: context.connectionId,
    applicationId: context.applicationId,
    guildId: context.guildId,
    generation: context.generation,
    keyId: context.keyId,
    deliveryId,
    dedupeKey,
    scopedDedupeKey: `${context.connectionId}:${context.generation}:${dedupeKey}`,
    idempotencyKey: `${item.idempotency_key ?? item.idempotencyKey ?? dedupeKey}`,
    orderingKey: `${item.ordering_key ?? item.orderingKey ?? `guild:${context.guildId}`}`,
    action: `${item.action ?? ''}`,
    actionVersion: Number(item.action_version ?? item.actionVersion ?? 1),
    lane: `${item.lane ?? 'normal'}`,
    attempt: Number(item.attempt ?? item.attempts ?? 1),
  });
};

export const stableConnectionId = ({ applicationId, guildId, endpointOrigin = '' }) => {
  const digest = createHash('sha256')
    .update(`${applicationId}:${guildId}:${endpointOrigin}`)
    .digest('hex');
  const hex = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return hex;
};
