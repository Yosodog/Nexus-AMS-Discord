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

test('interaction listener dispatches a user context command through its Nexus capability alias', async () => {
  const client = createEventClient();
  const logger = createLogger();
  let executed = false;
  let resolvedCommand = null;
  const connection = {
    applicationId: '423456789012345678',
    guildId: '123456789012345678',
    connectionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    generation: 1,
    keyId: 'key-1',
    capabilities: {},
  };
  registerInteractionListener(
    client,
    new Map([['View Nexus identity', {
      connectionCommandName: 'who',
      execute: async () => { executed = true; },
    }]]),
    logger,
    {
      applicationId: connection.applicationId,
      connectionResolver: {
        resolveInteraction: (_interaction, options) => {
          resolvedCommand = options.commandName;
          return connection;
        },
      },
      connectionServiceFactory: () => 'directory-api',
    },
  );
  await client.handlers.get(Events.InteractionCreate)({
    commandName: 'View Nexus identity',
    guildId: connection.guildId,
    user: { id: '223456789012345678' },
    isChatInputCommand: () => false,
    isUserContextMenuCommand: () => true,
  });

  assert.equal(resolvedCommand, 'who');
  assert.equal(executed, true);
});

test('interaction listener resolves a resource shortfall DM control through its bound guild', async () => {
  const client = createEventClient();
  const logger = createLogger();
  const connection = {
    applicationId: '423456789012345678',
    guildId: '123456789012345678',
    connectionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    generation: 1,
    keyId: 'key-1',
    capabilities: {},
  };
  let resolution;
  let requestedOccurrence;
  let requestedActor;
  const edits = [];
  registerInteractionListener(client, new Map(), logger, {
    applicationId: connection.applicationId,
    connectionResolver: {
      resolve: (input) => { resolution = input; return connection; },
    },
    connectionServiceFactory: () => ({
      getResourceShortfallOptions: async (_actor, occurrenceId) => {
        requestedActor = _actor;
        requestedOccurrence = occurrenceId;
        return { accounts: [] };
      },
    }),
  });

  await client.handlers.get(Events.InteractionCreate)({
    id: '323456789012345678',
    customId: `nxs:rsa:o:${connection.guildId}:91`,
    commandName: null,
    guildId: null,
    user: { id: '223456789012345678' },
    isButton: () => true,
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });

  assert.deepEqual(resolution, {
    applicationId: connection.applicationId,
    guildId: connection.guildId,
  });
  assert.equal(requestedOccurrence, '91');
  assert.equal(requestedActor.discordGuildId, connection.guildId);
  assert.equal(requestedActor.discordConnectionId, connection.connectionId);
  assert.equal(edits[0].embeds[0].toJSON().title, 'Resources No Longer Actionable');
});
