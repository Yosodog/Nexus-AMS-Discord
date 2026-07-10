import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { registerInteractionListener } from '../src/listeners/interactionCreate.js';
import { createEventClient, createLogger } from './helpers.js';

test('interaction listener ignores commands from foreign guilds without dispatching or replying', async () => {
  const client = createEventClient();
  const logger = createLogger();
  let executed = false;
  const commands = new Map([['ping', { execute: async () => { executed = true; } }]]);
  let replied = false;

  registerInteractionListener(client, commands, logger, {}, '123456789012345678');
  await client.handlers.get(Events.InteractionCreate)({
    commandName: 'ping',
    guildId: '223456789012345678',
    isChatInputCommand: () => true,
    reply: async () => { replied = true; },
  });

  assert.equal(executed, false);
  assert.equal(replied, false);
});

test('interaction listener injects the configured guild id into command context', async () => {
  const client = createEventClient();
  const logger = createLogger();
  let receivedContext = null;
  const commands = new Map([['ping', { execute: async (_interaction, context) => { receivedContext = context; } }]]);

  registerInteractionListener(client, commands, logger, { apiService: 'api' }, '123456789012345678');
  await client.handlers.get(Events.InteractionCreate)({
    commandName: 'ping',
    guildId: '123456789012345678',
    isChatInputCommand: () => true,
  });

  assert.equal(receivedContext.apiService, 'api');
  assert.equal(receivedContext.guildId, '123456789012345678');
});
