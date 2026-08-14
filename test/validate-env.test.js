import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { validateEnv } from '../src/utils/validateEnv.js';
import { createLogger } from './helpers.js';

const KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'NEXUS_API_URL',
  'NEXUS_API_KEY',
  'NEXUS_DISCORD_CONNECTION_ID',
  'NEXUS_DISCORD_CONNECTION_GENERATION',
  'NEXUS_DISCORD_RELAY_PRIVATE_KEY',
  'NEXUS_DISCORD_RELAY_KEY_ID',
  'NEXUS_DISCORD_RELAY_PROTOCOL',
  'NODE_ENV',
];

test('validateEnv permits development HTTP but requires production HTTPS and valid snowflakes', () => {
  const originalValues = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const originalExit = process.exit;
  const exits = [];
  process.exit = (code) => { exits.push(code); };

  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    Object.assign(process.env, {
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_CLIENT_ID: '123456789012345678',
      DISCORD_GUILD_ID: '223456789012345678',
      NEXUS_API_URL: 'http://nexus.local',
      NEXUS_API_KEY: 'key',
      NEXUS_DISCORD_CONNECTION_ID: '11111111-2222-4333-8444-555555555555',
      NEXUS_DISCORD_CONNECTION_GENERATION: '1',
      NEXUS_DISCORD_RELAY_PRIVATE_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      NEXUS_DISCORD_RELAY_KEY_ID: 'relay-current',
      NEXUS_DISCORD_RELAY_PROTOCOL: '2',
      NODE_ENV: 'development',
    });
    const required = KEYS.filter((key) => key !== 'NODE_ENV');
    assert.equal(validateEnv(required, createLogger()), true);

    process.env.NODE_ENV = 'production';
    const productionLogger = createLogger();
    assert.equal(validateEnv(required, productionLogger), false);
    assert.match(productionLogger.entries.error[0][0], /https in production/i);

    process.env.NEXUS_API_URL = 'https://nexus.example';
    process.env.DISCORD_GUILD_ID = 'not-a-snowflake';
    const snowflakeLogger = createLogger();
    assert.equal(validateEnv(required, snowflakeLogger), false);
    assert.match(snowflakeLogger.entries.error[0][0], /DISCORD_GUILD_ID/);

    process.env.DISCORD_GUILD_ID = '223456789012345678';
    process.env.NEXUS_DISCORD_RELAY_PRIVATE_KEY = 'not-a-key';
    const relayLogger = createLogger();
    assert.equal(validateEnv(required, relayLogger), false);
    assert.match(relayLogger.entries.error[0][0], /PKCS#8 Ed25519 private key/);
    process.env.NEXUS_DISCORD_RELAY_PRIVATE_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    process.env.NEXUS_DISCORD_RELAY_PROTOCOL = '1';
    const protocolLogger = createLogger();
    assert.equal(validateEnv(required, protocolLogger), false);
    assert.match(protocolLogger.entries.error[0][0], /protocol.*2/i);

    process.env.NEXUS_DISCORD_RELAY_PROTOCOL = '2';
    process.env.NEXUS_DISCORD_CONNECTION_ID = 'not-a-uuid';
    const connectionLogger = createLogger();
    assert.equal(validateEnv(required, connectionLogger), false);
    assert.match(connectionLogger.entries.error[0][0], /CONNECTION_ID.*UUID/i);

    process.env.NEXUS_DISCORD_CONNECTION_ID = '11111111-2222-4333-8444-555555555555';
    process.env.NEXUS_DISCORD_CONNECTION_GENERATION = '0';
    const generationLogger = createLogger();
    assert.equal(validateEnv(required, generationLogger), false);
    assert.match(generationLogger.entries.error[0][0], /GENERATION.*positive integer/i);

    process.env.NEXUS_DISCORD_CONNECTION_GENERATION = '1';
    process.env.NEXUS_DISCORD_RELAY_KEY_ID = 'Invalid key id';
    const keyIdLogger = createLogger();
    assert.equal(validateEnv(required, keyIdLogger), false);
    assert.match(keyIdLogger.entries.error[0][0], /RELAY_KEY_ID.*invalid/i);

    assert.deepEqual(exits, [1, 1, 1, 1, 1, 1, 1]);
  } finally {
    process.exit = originalExit;
    for (const [key, value] of Object.entries(originalValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
