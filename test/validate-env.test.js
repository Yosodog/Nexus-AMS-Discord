import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv } from '../src/utils/validateEnv.js';
import { createLogger } from './helpers.js';

const KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'NEXUS_API_URL',
  'NEXUS_API_KEY',
  'NODE_ENV',
];

test('validateEnv permits development HTTP but requires production HTTPS and valid snowflakes', () => {
  const originalValues = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const originalExit = process.exit;
  const exits = [];
  process.exit = (code) => { exits.push(code); };

  try {
    Object.assign(process.env, {
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_CLIENT_ID: '123456789012345678',
      DISCORD_GUILD_ID: '223456789012345678',
      NEXUS_API_URL: 'http://nexus.local',
      NEXUS_API_KEY: 'key',
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
    assert.deepEqual(exits, [1, 1]);
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
