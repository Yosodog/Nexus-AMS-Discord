import {
  createPrivateKey,
  createPublicKey,
  randomUUID as cryptoRandomUUID,
  sign,
} from 'node:crypto';
import {
  CONTRACT_SIGNING_DOMAINS,
  canonicalize,
  normalizePathQuery,
  parseJsonNoDuplicateKeys,
  publicKeyFromBase64Url,
  selectKeyFromSet,
  serializeBody,
  sha256Hex,
  verifySignedContract,
} from './connection/relayContracts.js';
import { registeredQueueActions } from './connection/Capabilities.js';

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const COMMAND_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;
const SERVICE_ACTION_PATTERN = /^[a-z][a-z0-9._:-]{0,99}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const RelayHeaders = Object.freeze({
  PAYLOAD: 'X-Nexus-Discord-Relay-Payload',
  SIGNATURE: 'X-Nexus-Discord-Relay-Signature',
  TIMESTAMP: 'X-Nexus-Discord-Relay-Timestamp',
  VERSION: 'X-Nexus-Discord-Relay-Version',
  CONNECTION_ID: 'X-Nexus-Discord-Relay-Connection-ID',
  GENERATION: 'X-Nexus-Discord-Relay-Generation',
  KEY_ID: 'X-Nexus-Discord-Relay-Key-ID',
});

const toPrivateKey = (privateKeyBase64) => {
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(`${privateKeyBase64 ?? ''}`.trim(), 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    throw new TypeError('NEXUS_DISCORD_RELAY_PRIVATE_KEY must be a base64 PKCS#8 Ed25519 private key.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('NEXUS_DISCORD_RELAY_PRIVATE_KEY must contain an Ed25519 private key.');
  }
  return privateKey;
};

const compactTimestamp = (date) => date.toISOString().replace('.000Z', 'Z');

const validateUuid = (value, label) => {
  const normalized = `${value ?? ''}`.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`${label} must be a canonical UUID.`);
  return normalized;
};

const validateSnowflake = (value, label) => {
  const normalized = `${value ?? ''}`.trim();
  if (!SNOWFLAKE_PATTERN.test(normalized)) throw new TypeError(`${label} must be a Discord snowflake.`);
  return normalized;
};

const validateAction = (value, pattern, label) => {
  const normalized = `${value ?? ''}`.trim().toLowerCase();
  if (!pattern.test(normalized)) throw new TypeError(`${label} is invalid.`);
  return normalized;
};

const publicKeyString = (privateKey) => {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return der.subarray(-32).toString('base64url');
};

const unsignedDocument = (document) => {
  const { signature: _signature, ...unsigned } = document;
  return unsigned;
};

const signDocument = (document, privateKey) => {
  const domain = CONTRACT_SIGNING_DOMAINS[document.contract];
  if (!domain) throw new TypeError(`Unsupported relay contract: ${document.contract}`);
  const input = `${domain}\n${canonicalize(unsignedDocument(document))}`;
  return {
    ...document,
    signature: {
      algorithm: 'ed25519',
      value: sign(null, Buffer.from(input), privateKey).toString('hex'),
    },
  };
};

const documentHeaders = (document) => {
  const issuedAtMs = Date.parse(document.issued_at);
  return {
    [RelayHeaders.PAYLOAD]: Buffer.from(JSON.stringify(document)).toString('base64url'),
    [RelayHeaders.SIGNATURE]: document.signature.value,
    [RelayHeaders.TIMESTAMP]: `${Math.floor(issuedAtMs / 1000)}`,
    [RelayHeaders.VERSION]: '2',
    [RelayHeaders.CONNECTION_ID]: document.connection_id,
    [RelayHeaders.GENERATION]: `${document.generation}`,
    [RelayHeaders.KEY_ID]: document.key_id,
  };
};

const keyInput = ({ keyId, privateKeyBase64, activatesAt = null, publicKey = null }) => {
  const privateKey = privateKeyBase64 ? toPrivateKey(privateKeyBase64) : null;
  const resolvedPublicKey = publicKey ?? (privateKey ? publicKeyString(privateKey) : null);
  return {
    keyId: `${keyId ?? ''}`.trim().toLowerCase(),
    privateKey,
    publicKey: resolvedPublicKey,
    activatesAt,
  };
};

export class DiscordRelaySigner {
  constructor({
    privateKeyBase64,
    guildId,
    appId = null,
    applicationId = appId,
    connectionId = null,
    generation = 1,
    protocolVersion = 1,
    keyScope = 'discord-relay->nexus',
    keyId = null,
    currentKeyId = null,
    nextKeyId = null,
    nextPrivateKeyBase64 = null,
    nextPublicKey = null,
    nextActivatesAt = null,
    clock = Date.now,
    randomUUID = cryptoRandomUUID,
  }) {
    this.guildId = validateSnowflake(guildId, 'Discord relay guildId');
    this.appId = applicationId ? validateSnowflake(applicationId, 'Discord relay appId') : null;
    this.protocolVersion = Number(protocolVersion) === 2 ? 2 : 1;
    this.connectionId = connectionId ? validateUuid(connectionId, 'Discord relay connectionId') : null;
    this.generation = Number(generation);
    if (!Number.isSafeInteger(this.generation) || this.generation < 1) {
      throw new TypeError('Discord relay generation must be a positive safe integer.');
    }
    this.keyScope = keyScope;
    this.clock = clock;
    this.randomUUID = randomUUID;

    if (this.protocolVersion === 2) {
      if (!this.appId || !this.connectionId) {
        throw new TypeError('Relay protocol v2 requires appId and connectionId.');
      }
      if (this.keyScope !== 'discord-relay->nexus') {
        throw new TypeError('Discord relay signer must use the discord-relay->nexus key scope.');
      }
    }

    const currentId = `${currentKeyId ?? keyId ?? (this.protocolVersion === 1 ? 'legacy-v1' : 'relay-current')}`
      .trim().toLowerCase();
    this.keys = {
      current: keyInput({ keyId: currentId, privateKeyBase64 }),
      next: null,
    };
    if (nextKeyId || nextPrivateKeyBase64 || nextPublicKey) {
      this.keys.next = keyInput({
        keyId: nextKeyId,
        privateKeyBase64: nextPrivateKeyBase64,
        publicKey: nextPublicKey,
        activatesAt: nextActivatesAt,
      });
      if (!this.keys.next.keyId || this.keys.next.keyId === this.keys.current.keyId) {
        throw new TypeError('Relay next key must have a distinct key id.');
      }
      if (!this.keys.next.publicKey) throw new TypeError('Relay next key requires public key material.');
    }
  }

  /** Legacy v1 wire shape retained for standalone and dedicated deployments. */
  interactionHeaders(actor, request = {}) {
    if (this.protocolVersion === 2 || request.protocolVersion === 2) {
      return documentHeaders(this.#v2Document('interaction', actor, request));
    }

    const userId = `${actor?.discordUserId ?? actor?.userId ?? ''}`.trim();
    const guildId = `${actor?.discordGuildId ?? actor?.guildId ?? ''}`.trim();
    const interactionId = `${actor?.discordInteractionId ?? actor?.interactionId ?? ''}`.trim();
    const command = `${actor?.discordCommand ?? actor?.command ?? 'interaction'}`.trim().toLowerCase();

    if (!SNOWFLAKE_PATTERN.test(userId) || !SNOWFLAKE_PATTERN.test(interactionId)) {
      throw new TypeError('Discord relay proof requires valid user and interaction snowflakes.');
    }
    if (!SNOWFLAKE_PATTERN.test(guildId) || guildId !== this.guildId) {
      throw new TypeError('Discord relay proof must use the configured guild.');
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(command)) {
      throw new TypeError('Discord relay proof requires a valid command name.');
    }

    return this.#legacyHeaders({
      relay_version: 1,
      proof_type: 'interaction',
      id: interactionId,
      guild_id: guildId,
      member: { user: { id: userId } },
      data: this.#commandData(command),
    }, {
      'X-Discord-User-ID': userId,
      'X-Discord-Guild-ID': guildId,
      'X-Discord-Interaction-ID': interactionId,
    });
  }

  /** Legacy service proof or a complete v2 signed relay-proof document. */
  serviceHeaders(action, request = {}) {
    if (this.protocolVersion === 2 || request.protocolVersion === 2) {
      return documentHeaders(this.#v2Document('service', { action }, request));
    }

    const normalizedAction = `${action ?? ''}`.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalizedAction)) {
      throw new TypeError('Discord relay service proof requires a valid action.');
    }

    return this.#legacyHeaders({
      relay_version: 1,
      proof_type: 'service',
      nonce: this.randomUUID(),
      guild_id: this.guildId,
      action: normalizedAction,
    });
  }

  createCapabilityManifest({
    manifestId = this.randomUUID(),
    issuedAt = null,
    expiresAt = null,
    supportedQueueActions = null,
    renderers = [],
    limits = {},
  } = {}) {
    if (this.protocolVersion !== 2) throw new TypeError('Capability manifests require relay protocol v2.');
    const issued = issuedAt ? new Date(issuedAt) : new Date(this.clock());
    const expires = expiresAt ? new Date(expiresAt) : new Date(issued.getTime() + 24 * 60 * 60 * 1000);
    const current = this.keys.current;
    const next = this.keys.next;
    const document = {
      contract: 'capability-manifest',
      contract_version: 1,
      issuer: 'discord-relay',
      audience: 'nexus',
      key_scope: this.keyScope,
      manifest_id: validateUuid(manifestId, 'manifestId'),
      connection_id: this.connectionId,
      app_id: this.appId,
      guild_id: this.guildId,
      generation: this.generation,
      key_id: current.keyId,
      issued_at: compactTimestamp(issued),
      expires_at: compactTimestamp(expires),
      supported_queue_actions: [...(supportedQueueActions ?? registeredQueueActions())],
      renderers: [...renderers],
      limits: {
        max_batch_items: 100,
        max_delivery_bytes: 16_384,
        max_proof_bytes: 65_536,
        max_receipt_bytes: 262_144,
        max_clock_skew_seconds: 60,
        max_lease_seconds: 300,
        dedupe_window_seconds: 86_400,
        max_delivery_attempts: 8,
        ...limits,
      },
      key_set: {
        owner: 'discord-relay',
        scope: this.keyScope,
        current: {
          key_id: current.keyId,
          algorithm: 'ed25519',
          public_key: current.publicKey,
          activated_at: compactTimestamp(issued),
        },
        next: next ? {
          key_id: next.keyId,
          algorithm: 'ed25519',
          public_key: next.publicKey,
          activates_at: next.activatesAt ?? compactTimestamp(new Date(issued.getTime() + 60_000)),
        } : null,
      },
    };
    return signDocument(document, current.privateKey);
  }

  #v2Document(type, actor, request) {
    const key = this.#activeKey();
    const issued = request.issuedAt ? new Date(request.issuedAt) : new Date(this.clock());
    const expires = request.expiresAt
      ? new Date(request.expiresAt)
      : new Date(issued.getTime() + 30_000);
    if (!Number.isFinite(issued.getTime()) || !Number.isFinite(expires.getTime()) || expires <= issued) {
      throw new TypeError('Relay proof issuedAt/expiresAt must be valid and ordered.');
    }

    const action = validateAction(
      actor?.discordAction ?? actor?.action ?? actor?.discordCommand ?? actor?.command,
      type === 'service' ? SERVICE_ACTION_PATTERN : ACTION_PATTERN,
      'Relay proof action',
    );
    const idempotencyKey = validateUuid(request.idempotencyKey ?? this.randomUUID(), 'Relay idempotencyKey');
    const body = serializeBody(request.body ?? request.data);
    const target = normalizePathQuery(request.normalizedPathQuery ?? request.path ?? request.url ?? '/');
    const method = `${request.method ?? 'POST'}`.trim().toUpperCase();
    if (!['DELETE', 'GET', 'PATCH', 'POST', 'PUT'].includes(method)) {
      throw new TypeError('Relay proof method is not supported.');
    }

    const document = {
      contract: 'relay-proof',
      contract_version: 2,
      issuer: 'discord-relay',
      audience: 'nexus',
      key_scope: this.keyScope,
      connection_id: this.connectionId,
      app_id: this.appId,
      guild_id: this.guildId,
      generation: this.generation,
      key_id: key.keyId,
      issued_at: compactTimestamp(issued),
      expires_at: compactTimestamp(expires),
      idempotency_key: idempotencyKey,
      proof: type === 'interaction'
        ? {
            type,
            interaction_id: validateSnowflake(actor?.discordInteractionId ?? actor?.interactionId, 'interactionId'),
            user_id: validateSnowflake(actor?.discordUserId ?? actor?.userId, 'userId'),
            command: validateAction(actor?.discordCommand ?? actor?.command ?? action.split('.')[0], COMMAND_PATTERN, 'Relay proof command'),
            action,
          }
        : { type, action, nonce: validateUuid(request.nonce ?? this.randomUUID(), 'Relay nonce') },
      method,
      normalized_path_query: target,
      body_sha256: sha256Hex(body),
    };
    return signDocument(document, key.privateKey);
  }

  #activeKey() {
    const now = this.clock();
    const next = this.keys.next;
    if (next?.privateKey && next.activatesAt && Date.parse(next.activatesAt) <= now) return next;
    if (!this.keys.current.privateKey) throw new TypeError('Current relay signing key is not configured.');
    return this.keys.current;
  }

  #legacyHeaders(payload, extra = {}) {
    const encodedPayload = JSON.stringify(payload);
    const timestamp = `${Math.floor(this.clock() / 1000)}`;
    const signature = sign(null, Buffer.from(timestamp + encodedPayload), this.keys.current.privateKey);
    return {
      [RelayHeaders.PAYLOAD]: Buffer.from(encodedPayload).toString('base64url'),
      [RelayHeaders.SIGNATURE]: signature.toString('hex'),
      [RelayHeaders.TIMESTAMP]: timestamp,
      ...extra,
    };
  }

  #commandData(command) {
    const [name, ...subcommands] = command.split('.');
    let options = [];
    for (const subcommand of subcommands.reverse()) {
      options = [{
        type: 1,
        name: subcommand,
        ...(options.length > 0 ? { options } : {}),
      }];
    }
    return { name, ...(options.length > 0 ? { options } : {}) };
  }
}

/**
 * Verifies the locked HTTP header convention. The signed document is the
 * authority; duplicated or disagreeing header metadata is never trusted.
 */
export const verifyRelayHeaders = (
  headers,
  {
    publicKeys = {},
    expected = {},
    request = null,
    now = Date.now(),
    maxClockSkewSeconds = 60,
  } = {},
) => {
  const payload = headers?.[RelayHeaders.PAYLOAD];
  const signatureHeader = headers?.[RelayHeaders.SIGNATURE];
  const timestampHeader = headers?.[RelayHeaders.TIMESTAMP];
  if (typeof payload !== 'string' || typeof signatureHeader !== 'string' || typeof timestampHeader !== 'string') {
    return { valid: false, reason: 'missing_relay_headers' };
  }
  if (headers[RelayHeaders.VERSION] !== '2') return { valid: false, reason: 'missing_relay_version' };
  let document;
  try {
    document = parseJsonNoDuplicateKeys(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed_relay_payload' };
  }
  if (document?.contract !== 'relay-proof' || document?.contract_version !== 2) {
    return { valid: false, reason: 'unsupported_relay_contract' };
  }
  if (document?.signature?.value !== signatureHeader) return { valid: false, reason: 'header_signature_mismatch' };
  const issuedAt = Date.parse(document?.issued_at ?? '');
  if (!Number.isFinite(issuedAt) || `${Math.floor(issuedAt / 1000)}` !== timestampHeader) {
    return { valid: false, reason: 'header_timestamp_mismatch' };
  }
  for (const [header, expectedValue] of [
    [RelayHeaders.VERSION, '2'],
    [RelayHeaders.CONNECTION_ID, document?.connection_id],
    [RelayHeaders.GENERATION, `${document?.generation ?? ''}`],
    [RelayHeaders.KEY_ID, document?.key_id],
  ]) {
    if (headers[header] !== undefined && headers[header] !== expectedValue) {
      return { valid: false, reason: 'header_document_mismatch' };
    }
  }
  const publicKeyValue = publicKeys[document?.key_id]
    ?? (publicKeys.current?.key_id === document?.key_id
      ? publicKeys.current?.public_key
      : (publicKeys.next?.key_id === document?.key_id ? publicKeys.next?.public_key : null));
  const publicKey = publicKeyValue?.public_key ?? publicKeyValue;
  if (!publicKey) return { valid: false, reason: 'unknown_relay_key' };
  const semanticExpected = {
    issuer: 'discord-relay',
    audience: 'nexus',
    key_scope: 'discord-relay->nexus',
    ...expected,
  };
  const verified = verifySignedContract(document, publicKey, {
    expected: semanticExpected,
    now,
    maxClockSkewSeconds,
  });
  if (!verified.valid) return verified;
  if (request) {
    let method;
    let target;
    let bodyHash;
    try {
      method = `${request.method ?? ''}`.toUpperCase();
      target = normalizePathQuery(request.path ?? request.url ?? '/');
      bodyHash = sha256Hex(serializeBody(request.body ?? request.data));
    } catch {
      return { valid: false, reason: 'request_binding_mismatch' };
    }
    if (document.method !== method || document.normalized_path_query !== target || document.body_sha256 !== bodyHash) {
      return { valid: false, reason: 'request_binding_mismatch' };
    }
    if (request.action && document.proof?.action !== request.action) {
      return { valid: false, reason: 'action_binding_mismatch' };
    }
  }
  return verified;
};

export const relayPublicKey = (encoded) => publicKeyFromBase64Url(encoded);
