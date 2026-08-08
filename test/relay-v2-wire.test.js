import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import {
  DiscordRelaySigner,
  RelayHeaders,
  verifyRelayHeaders,
} from '../src/services/DiscordRelaySigner.js';
import { registeredQueueActions } from '../src/services/connection/Capabilities.js';
import { normalizePathQuery } from '../src/services/connection/relayContracts.js';

const APP_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const CONNECTION_ID = '11111111-2222-4333-8444-555555555555';
const ACTOR = {
  discordUserId: '423456789012345678',
  discordGuildId: GUILD_ID,
  discordInteractionId: '323456789012345678',
  discordCommand: 'applications',
  discordAction: 'applications.approve',
};
const REQUEST = {
  method: 'POST',
  path: '/api/v1/discord/staff/applications/opaque/approve?a=1&a=1&b=2',
};

const fixedPrivateKey = () => createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
  ]),
  format: 'der',
  type: 'pkcs8',
});

const base64Private = (key) => key.export({ format: 'der', type: 'pkcs8' }).toString('base64');

const makeSigner = (options = {}) => new DiscordRelaySigner({
  privateKeyBase64: base64Private(fixedPrivateKey()),
  appId: APP_ID,
  guildId: GUILD_ID,
  connectionId: CONNECTION_ID,
  generation: 7,
  protocolVersion: 2,
  keyId: 'relay-current-2026-01',
  clock: () => Date.parse('2026-08-08T12:00:00Z'),
  randomUUID: () => '33333333-4444-4555-8666-777777777777',
  ...options,
});

test('v2 uses the locked legacy header names and embeds the complete signed document', () => {
  const signer = makeSigner();
  const headers = signer.interactionHeaders(ACTOR, {
    ...REQUEST,
    expiresAt: '2026-08-08T12:00:30Z',
  });
  const document = JSON.parse(Buffer.from(headers[RelayHeaders.PAYLOAD], 'base64url').toString('utf8'));

  assert.equal(headers[RelayHeaders.SIGNATURE], document.signature.value);
  assert.equal(headers[RelayHeaders.TIMESTAMP], '1786190400');
  assert.equal(headers[RelayHeaders.VERSION], '2');
  assert.equal(headers[RelayHeaders.CONNECTION_ID], CONNECTION_ID);
  assert.equal(headers[RelayHeaders.GENERATION], '7');
  assert.equal(headers[RelayHeaders.KEY_ID], 'relay-current-2026-01');
  assert.equal(document.signature.algorithm, 'ed25519');
  assert.deepEqual(document.proof, {
    type: 'interaction',
    interaction_id: ACTOR.discordInteractionId,
    user_id: ACTOR.discordUserId,
    command: 'applications',
    action: 'applications.approve',
  });

  const publicKey = createPublicKey(fixedPrivateKey());
  assert.equal(verifyRelayHeaders(headers, {
    publicKeys: { [document.key_id]: publicKey },
    expected: {
      connection_id: CONNECTION_ID,
      app_id: APP_ID,
      guild_id: GUILD_ID,
      generation: 7,
    },
    request: { ...REQUEST, action: 'applications.approve' },
    now: Date.parse('2026-08-08T12:00:01Z'),
  }).valid, true);
});

test('v2 rejects header/document disagreement, forged payloads, and request tampering', () => {
  const signer = makeSigner();
  const headers = signer.interactionHeaders(ACTOR, {
    ...REQUEST,
    expiresAt: '2026-08-08T12:00:30Z',
  });
  const document = JSON.parse(Buffer.from(headers[RelayHeaders.PAYLOAD], 'base64url').toString('utf8'));
  const publicKey = createPublicKey(fixedPrivateKey());
  const options = {
    publicKeys: { [document.key_id]: publicKey },
    request: { ...REQUEST, action: 'applications.approve' },
    now: Date.parse('2026-08-08T12:00:01Z'),
  };

  assert.equal(verifyRelayHeaders({ ...headers, [RelayHeaders.SIGNATURE]: '0'.repeat(128) }, options).reason,
    'header_signature_mismatch');
  assert.equal(verifyRelayHeaders({ ...headers, [RelayHeaders.TIMESTAMP]: '1786190401' }, options).reason,
    'header_timestamp_mismatch');

  const forgedDocument = { ...document, proof: { ...document.proof, action: 'applications.deny' } };
  const forgedHeaders = {
    ...headers,
    [RelayHeaders.PAYLOAD]: Buffer.from(JSON.stringify(forgedDocument)).toString('base64url'),
  };
  assert.equal(verifyRelayHeaders(forgedHeaders, options).reason, 'signature_mismatch');
  assert.equal(verifyRelayHeaders(headers, {
    ...options,
    request: { ...REQUEST, action: 'applications.deny' },
  }).reason, 'action_binding_mismatch');
  assert.equal(verifyRelayHeaders(headers, {
    ...options,
    request: { ...REQUEST, path: `${REQUEST.path}&foreign=1`, action: 'applications.approve' },
  }).reason, 'request_binding_mismatch');
  assert.equal(verifyRelayHeaders(headers, {
    ...options,
    request: { ...REQUEST, path: '/api/%7Estatus', action: 'applications.approve' },
  }).reason, 'request_binding_mismatch');
  assert.equal(verifyRelayHeaders({ ...headers, [RelayHeaders.VERSION]: '1' }, options).reason, 'missing_relay_version');
});

test('v2 rejects duplicate JSON keys before signature verification', () => {
  const headers = {
    [RelayHeaders.PAYLOAD]: Buffer.from('{"contract":"relay-proof","contract":"relay-proof"}').toString('base64url'),
    [RelayHeaders.SIGNATURE]: '0'.repeat(128),
    [RelayHeaders.TIMESTAMP]: '1786190400',
    [RelayHeaders.VERSION]: '2',
  };
  assert.equal(verifyRelayHeaders(headers).reason, 'malformed_relay_payload');
});

test('relay target normalization matches Nexus path and query parity rules', () => {
  assert.throws(() => normalizePathQuery('/api/./status'), /dot path segments/);
  assert.throws(() => normalizePathQuery('/api/../status'), /dot path segments/);
  assert.throws(() => normalizePathQuery('https://nexus.example/api/../status'), /dot path segments/);
  assert.throws(() => normalizePathQuery('/api/%7Estatus'), /percent-encode unreserved/);
  assert.equal(normalizePathQuery('/api/status?b=2&a=1&a=0'), '/api/status?a=0&a=1&b=2');
  assert.equal(normalizePathQuery('/api/status?q=literal+plus'), '/api/status?q=literal+plus');
  assert.equal(normalizePathQuery('/api/status?q=encoded%20space'), '/api/status?q=encoded%20space');
  assert.throws(() => normalizePathQuery('/api/status?q=encoded%7E'), /percent-encode unreserved/);
  assert.equal(
    normalizePathQuery('/api/%7Estatus?q=literal%7E', { rejectEncodedUnreserved: false }),
    '/api/~status?q=literal~',
  );
});

test('current and next relay keys rotate independently without changing the connection binding', () => {
  const { privateKey: nextPrivate, publicKey: nextPublic } = generateKeyPairSync('ed25519');
  const nextPublicBytes = nextPublic.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  let now = Date.parse('2026-08-08T12:00:00Z');
  const signer = makeSigner({
    clock: () => now,
    nextKeyId: 'relay-next-2026-02',
    nextPrivateKeyBase64: base64Private(nextPrivate),
    nextPublicKey: nextPublicBytes,
    nextActivatesAt: '2026-08-08T12:01:00Z',
  });

  const current = JSON.parse(Buffer.from(signer.interactionHeaders(ACTOR, REQUEST)[RelayHeaders.PAYLOAD], 'base64url'));
  now = Date.parse('2026-08-08T12:02:00Z');
  const next = JSON.parse(Buffer.from(signer.interactionHeaders(ACTOR, REQUEST)[RelayHeaders.PAYLOAD], 'base64url'));
  assert.equal(current.key_id, 'relay-current-2026-01');
  assert.equal(next.key_id, 'relay-next-2026-02');
  assert.equal(next.connection_id, CONNECTION_ID);
  assert.equal(next.generation, 7);
});

test('capability manifests derive queue actions from the registered action set', () => {
  const document = makeSigner().createCapabilityManifest({
    manifestId: '66666666-7777-4777-8888-999999999999',
    issuedAt: '2026-08-08T12:00:00Z',
    expiresAt: '2026-08-09T00:00:00Z',
    renderers: [{ renderer_id: 'discord.embed', version: 1, max_payload_bytes: 16_384 }],
  });
  assert.deepEqual(document.supported_queue_actions, registeredQueueActions());
});

test('v1 retains its exact current payload/signature/timestamp shape', () => {
  const signer = new DiscordRelaySigner({
    privateKeyBase64: base64Private(fixedPrivateKey()),
    guildId: GUILD_ID,
    clock: () => 1_700_000_000_000,
    randomUUID: () => '11111111-2222-4333-8444-555555555555',
  });
  const headers = signer.interactionHeaders({
    discordUserId: ACTOR.discordUserId,
    discordGuildId: GUILD_ID,
    discordInteractionId: ACTOR.discordInteractionId,
    discordCommand: 'applications.approve',
  });
  assert.deepEqual(Object.keys(headers).sort(), [
    'X-Discord-Guild-ID',
    'X-Discord-Interaction-ID',
    'X-Discord-User-ID',
    'X-Nexus-Discord-Relay-Payload',
    'X-Nexus-Discord-Relay-Signature',
    'X-Nexus-Discord-Relay-Timestamp',
  ].sort());
});
