import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { registerMessageListener } from '../src/listeners/messageCreate.js';
import { config } from '../src/utils/config.js';
import { createEventClient, createLogger, embedJson } from './helpers.js';

test('registerMessageListener skips registration when ApiService is missing', () => {
  const client = createEventClient();
  const logger = createLogger();

  registerMessageListener(client, null, logger);

  assert.equal(client.handlers.size, 0);
  assert.equal(logger.entries.warn[0][0], 'ApiService missing; skipping message listener registration.');
});

test('message listener logs text messages from application channels', async () => {
  const client = createEventClient();
  const logger = createLogger();
  let loggedPayload = null;
  const apiService = {
    logApplicationMessage: async (payload) => {
      loggedPayload = payload;
      return { logged: true };
    },
    sendIntelReport: async () => assert.fail('non-intel message should not be sent as intel'),
  };

  registerMessageListener(client, apiService, logger, 'guild-1');
  const handler = client.handlers.get(Events.MessageCreate);

  await handler({
    guild: { id: 'guild-1' },
    channel: { name: 'app-123-456-target' },
    channelId: 'channel-1',
    id: 'message-1',
    author: { id: 'user-1', tag: 'User#1234' },
    content: 'Application answer',
    createdTimestamp: 1_700_000_000_000,
    attachments: new Map(),
  });

  assert.deepEqual(loggedPayload, {
    discord_channel_id: 'channel-1',
    discord_message_id: 'message-1',
    discord_user_id: 'user-1',
    discord_username: 'User#1234',
    content: 'Application answer',
    sent_at: 1_700_000_000,
  });
});

test('message listener recognizes metadata-marked channels after a safe rename', async () => {
  const client = createEventClient();
  const logger = createLogger();
  let loggedPayload = null;
  const apiService = {
    logApplicationMessage: async (payload) => { loggedPayload = payload; },
    sendIntelReport: async () => assert.fail('non-intel message should not be sent as intel'),
  };

  registerMessageListener(client, apiService, logger, 'guild-1');
  await client.handlers.get(Events.MessageCreate)({
    guild: { id: 'guild-1' },
    channel: { name: 'interview-renamed-by-staff', topic: 'nexus-application:123;nation:456' },
    channelId: 'channel-1',
    id: 'message-1',
    author: { id: 'user-1', username: 'User' },
    content: 'Application answer',
    createdTimestamp: 1_700_000_000_000,
  });

  assert.equal(loggedPayload.content, 'Application answer');
});

test('message listener ignores empty app-channel messages without attachments', async () => {
  const client = createEventClient();
  const logger = createLogger();
  const apiService = {
    logApplicationMessage: async () => assert.fail('empty message should not be logged'),
    sendIntelReport: async () => assert.fail('empty message should not be sent as intel'),
  };

  registerMessageListener(client, apiService, logger, 'guild-1');
  const handler = client.handlers.get(Events.MessageCreate);

  await handler({
    guild: { id: 'guild-1' },
    channel: { name: 'app-123-456-target' },
    channelId: 'channel-1',
    id: 'message-1',
    author: { id: 'user-1', username: 'User' },
    content: '',
    createdTimestamp: Date.now(),
    attachments: new Map(),
  });
});

test('message listener ignores attachment-only application messages', async () => {
  const client = createEventClient();
  const logger = createLogger();
  const apiService = {
    logApplicationMessage: async () => assert.fail('attachment-only message should not be logged'),
    sendIntelReport: async () => assert.fail('attachment-only message should not be sent as intel'),
  };

  registerMessageListener(client, apiService, logger, 'guild-1');
  const handler = client.handlers.get(Events.MessageCreate);

  await handler({
    guild: { id: 'guild-1' },
    channel: { name: 'app-123-456-target' },
    channelId: 'channel-1',
    id: 'message-1',
    author: { id: 'user-1', username: 'User' },
    content: '',
    createdTimestamp: Date.now(),
    attachments: new Map([['attachment-1', { url: 'https://example.test/file' }]]),
  });
});

test('message listener ignores all messages from a foreign guild', async () => {
  const client = createEventClient();
  const logger = createLogger();
  const apiService = {
    logApplicationMessage: async () => assert.fail('foreign message should not be logged'),
    sendIntelReport: async () => assert.fail('foreign message should not be sent as intel'),
  };

  registerMessageListener(client, apiService, logger, 'guild-1');
  const handler = client.handlers.get(Events.MessageCreate);

  await handler({
    guild: { id: 'guild-2' },
    channel: { name: 'app-123-456-target' },
    content: 'Application answer',
  });
});

test('message listener forwards intel reports and replies with the Nexus intel URL', async () => {
  const originalBaseUrl = config.nexusApi.baseUrl;
  config.nexusApi.baseUrl = 'https://nexus.example';

  try {
    const client = createEventClient();
    const logger = createLogger();
    let intelPayload = null;
    let replyPayload = null;
    const apiService = {
      logApplicationMessage: async () => assert.fail('non-app channel should not be logged'),
      sendIntelReport: async (payload) => {
        intelPayload = payload;
      },
    };

    registerMessageListener(client, apiService, logger, 'guild-1');
    const handler = client.handlers.get(Events.MessageCreate);
    const content =
      'ABC successfully gathered intelligence about Test Nation. The operation cost you $1,234.00 and 0 of your spies were captured and executed.';

    await handler({
      guild: { id: 'guild-1' },
      channel: { name: 'general' },
      channelId: 'channel-1',
      id: 'message-1',
      author: { id: 'user-1', username: 'User' },
      content,
      createdTimestamp: Date.now(),
      attachments: new Map(),
      reply: async (payload) => {
        replyPayload = payload;
      },
    });

    assert.deepEqual(intelPayload, { report: content, source: 'discord' });
    assert.equal(embedJson(replyPayload).title, 'Intel Report Saved');
    assert.match(embedJson(replyPayload).description, /https:\/\/nexus\.example\/defense\/intel/);
    assert.deepEqual(replyPayload.allowedMentions, { parse: [], repliedUser: false });
  } finally {
    config.nexusApi.baseUrl = originalBaseUrl;
  }
});

test('message listener ignores bot-authored application messages', async () => {
  const client = createEventClient();
  const logger = createLogger();
  const apiService = {
    logApplicationMessage: async () => assert.fail('bot message should not be logged'),
    sendIntelReport: async () => assert.fail('bot message should not be sent as intel'),
  };

  registerMessageListener(client, apiService, logger, 'guild-1');
  await client.handlers.get(Events.MessageCreate)({
    guild: { id: 'guild-1' },
    channel: { name: 'app-123-456-target' },
    channelId: 'channel-1',
    id: 'message-1',
    author: { id: 'bot-1', username: 'Nexus', bot: true },
    content: 'Automated application update',
    createdTimestamp: Date.now(),
  });
});

test('message listener tells the user when an intel report cannot be saved', async () => {
  const client = createEventClient();
  const logger = createLogger();
  let replyPayload = null;
  registerMessageListener(client, {
    logApplicationMessage: async () => {},
    sendIntelReport: async () => { throw new Error('offline'); },
  }, logger, 'guild-1');

  await client.handlers.get(Events.MessageCreate)({
    guild: { id: 'guild-1' },
    channel: { name: 'general' },
    channelId: 'channel-1',
    id: 'message-1',
    author: { id: 'user-1', username: 'User' },
    content: 'ABC successfully gathered intelligence about Test Nation. The operation cost you $1,234.00 and 0 of your spies were captured and executed.',
    createdTimestamp: Date.now(),
    reply: async (payload) => { replyPayload = payload; },
  });

  assert.equal(embedJson(replyPayload).title, 'Intel Report Not Saved');
  assert.equal(logger.entries.warn[0][0], 'Failed to submit intel report to Nexus');
});
