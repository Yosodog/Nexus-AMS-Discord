import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DiscordRelaySigner, RelayHeaders } from '../src/services/DiscordRelaySigner.js';

const APP_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const CONNECTION_ID = '11111111-2222-4333-8444-555555555555';
const { privateKey } = generateKeyPairSync('ed25519');
const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

const signer = new DiscordRelaySigner({
  privateKeyBase64,
  appId: APP_ID,
  guildId: GUILD_ID,
  connectionId: CONNECTION_ID,
  generation: 7,
  protocolVersion: 2,
  keyId: 'relay-current',
  clock: () => 1_700_000_000_000,
  randomUUID: () => '11111111-2222-4333-8444-555555555555',
});

const readPayload = (headers) => JSON.parse(
  Buffer.from(headers[RelayHeaders.PAYLOAD], 'base64url').toString('utf8'),
);

test('DiscordRelaySigner signs the actual gateway actor and command path as relay-v2', () => {
  const headers = signer.interactionHeaders({
    discordUserId: '323456789012345678',
    discordGuildId: GUILD_ID,
    discordInteractionId: '423456789012345678',
    discordCommand: 'applications',
    discordAction: 'applications.approve',
  }, {
    method: 'POST',
    path: '/api/v1/discord/applications/confirm',
    body: { intent_id: 'intent-1' },
  });
  const payload = readPayload(headers);

  assert.equal(headers[RelayHeaders.VERSION], '2');
  assert.equal(headers[RelayHeaders.CONNECTION_ID], CONNECTION_ID);
  assert.equal(headers[RelayHeaders.GENERATION], '7');
  assert.equal(payload.contract, 'relay-proof');
  assert.equal(payload.contract_version, 2);
  assert.deepEqual(payload.proof, {
    type: 'interaction',
    interaction_id: '423456789012345678',
    user_id: '323456789012345678',
    command: 'applications',
    action: 'applications.approve',
  });
});

test('DiscordRelaySigner signs action-bound service callbacks as relay-v2', () => {
  const payload = readPayload(signer.serviceHeaders('war-counters.attach-channel', {
    method: 'POST',
    path: '/api/v1/discord/war-counters/attach-channel',
    body: { war_counter_id: 7 },
  }));

  assert.equal(payload.contract, 'relay-proof');
  assert.equal(payload.contract_version, 2);
  assert.deepEqual(payload.proof, {
    type: 'service',
    action: 'war-counters.attach-channel',
    nonce: '11111111-2222-4333-8444-555555555555',
  });
});

test('DiscordRelaySigner rejects protocol versions other than v2 and incomplete bindings', () => {
  assert.throws(
    () => new DiscordRelaySigner({
      privateKeyBase64,
      appId: APP_ID,
      guildId: GUILD_ID,
      connectionId: CONNECTION_ID,
      protocolVersion: 1,
    }),
    /relay protocol v2/i,
  );
  assert.throws(
    () => new DiscordRelaySigner({ privateKeyBase64, guildId: GUILD_ID }),
    /appId and connectionId/i,
  );
  assert.throws(
    () => signer.interactionHeaders({
      discordUserId: '323456789012345678',
      discordGuildId: '923456789012345678',
      discordInteractionId: '423456789012345678',
      discordCommand: 'sweepbank',
      discordAction: 'sweepbank',
    }),
    /configured guild/i,
  );
});
