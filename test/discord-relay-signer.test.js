import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { DiscordRelaySigner, RelayHeaders } from '../src/services/DiscordRelaySigner.js';

const GUILD_ID = '123456789012345678';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

const signer = new DiscordRelaySigner({
  privateKeyBase64,
  guildId: GUILD_ID,
  clock: () => 1_700_000_000_000,
  randomUUID: () => '11111111-2222-4333-8444-555555555555',
});

function verifyHeaders(headers) {
  const payload = Buffer.from(headers[RelayHeaders.PAYLOAD], 'base64url').toString();
  const signature = Buffer.from(headers[RelayHeaders.SIGNATURE], 'hex');
  assert.equal(
    verify(null, Buffer.from(headers[RelayHeaders.TIMESTAMP] + payload), publicKey, signature),
    true,
  );
  return JSON.parse(payload);
}

test('DiscordRelaySigner signs the actual gateway actor and command path', () => {
  const headers = signer.interactionHeaders({
    discordUserId: '223456789012345678',
    discordGuildId: GUILD_ID,
    discordInteractionId: '323456789012345678',
    discordCommand: 'applications.approve',
  });
  const payload = verifyHeaders(headers);

  assert.equal(headers[RelayHeaders.TIMESTAMP], '1700000000');
  assert.equal(payload.proof_type, 'interaction');
  assert.equal(payload.id, '323456789012345678');
  assert.equal(payload.guild_id, GUILD_ID);
  assert.equal(payload.member.user.id, '223456789012345678');
  assert.deepEqual(payload.data, {
    name: 'applications',
    options: [{ type: 1, name: 'approve' }],
  });
});

test('DiscordRelaySigner signs action-bound service callbacks', () => {
  const payload = verifyHeaders(signer.serviceHeaders('war-counters.attach-channel'));

  assert.deepEqual(payload, {
    relay_version: 1,
    proof_type: 'service',
    nonce: '11111111-2222-4333-8444-555555555555',
    guild_id: GUILD_ID,
    action: 'war-counters.attach-channel',
  });
});

test('DiscordRelaySigner rejects invalid keys and caller-asserted guilds', () => {
  assert.throws(
    () => new DiscordRelaySigner({ privateKeyBase64: 'not-a-key', guildId: GUILD_ID }),
    /PKCS#8 Ed25519 private key/,
  );
  assert.throws(
    () => signer.interactionHeaders({
      discordUserId: '223456789012345678',
      discordGuildId: '999999999999999999',
      discordInteractionId: '323456789012345678',
      discordCommand: 'sweepbank',
    }),
    /configured guild/,
  );
});
