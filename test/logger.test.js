import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../src/services/Logger.js';

test('Logger filters levels, redacts credentials, and preserves correlation ids', (t) => {
  const previousToken = process.env.DISCORD_BOT_TOKEN;
  const previousKey = process.env.NEXUS_API_KEY;
  process.env.DISCORD_BOT_TOKEN = 'bot-secret-value';
  process.env.NEXUS_API_KEY = 'api-secret-value';
  t.after(() => {
    if (previousToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = previousToken;
    if (previousKey === undefined) delete process.env.NEXUS_API_KEY;
    else process.env.NEXUS_API_KEY = previousKey;
  });

  const output = [];
  t.mock.method(console, 'log', (message) => output.push(message));
  const logger = new Logger('Test', { level: 'INFO' });
  logger.debug('hidden debug message');
  logger.info('correlation', {
    guildId: '123456789012345678',
    token: 'bot-secret-value',
    apiKey: 'api-secret-value',
  });

  assert.equal(output.length, 1);
  assert.match(output[0], /123456789012345678/);
  assert.doesNotMatch(output[0], /bot-secret-value|api-secret-value/);
});

test('Logger does not serialize Axios response bodies from direct Error arguments', (t) => {
  const output = [];
  t.mock.method(console, 'error', (message) => output.push(message));
  const logger = new Logger('Test', { level: 'ERROR' });
  const error = new Error('request failed');
  error.code = 'ERR_BAD_RESPONSE';
  error.response = { status: 500, data: { secret: 'response-body-secret' } };
  logger.error('request', error);

  assert.equal(output.length, 1);
  assert.match(output[0], /ERR_BAD_RESPONSE/);
  assert.match(output[0], /status: 500/);
  assert.doesNotMatch(output[0], /response-body-secret/);
});
