import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveWarCounterRoom,
  resolveWarCounterChannelIdFromCounter,
} from '../src/utils/warCounterRooms.js';
import { createLogger } from './helpers.js';

const GUILD_ID = '123456789012345678';
const THREAD_ID = '223456789012345678';

test('resolveWarCounterChannelIdFromCounter accepts only the persisted Discord channel id', () => {
  assert.equal(
    resolveWarCounterChannelIdFromCounter({
      discord_channel_id: ` ${THREAD_ID} `,
      channel_id: '323456789012345678',
    }),
    THREAD_ID,
  );

  assert.equal(resolveWarCounterChannelIdFromCounter({ thread_id: THREAD_ID }), null);
  assert.equal(resolveWarCounterChannelIdFromCounter({ discord_channel_id: 'not-a-snowflake' }), null);
  assert.equal(resolveWarCounterChannelIdFromCounter({ discord_channel_id: 123456789012345678 }), null);
  assert.equal(resolveWarCounterChannelIdFromCounter({}), null);
  assert.equal(resolveWarCounterChannelIdFromCounter(null), null);
});

test('archiveWarCounterRoom renames, archives, and locks an active thread', async () => {
  const logger = createLogger();
  const operations = [];
  const thread = {
    id: THREAD_ID,
    guildId: GUILD_ID,
    name: 'counter-room',
    archived: false,
    locked: false,
    isThread: () => true,
    setName: async (name, reason) => {
      operations.push(['setName', name, reason]);
      thread.name = name;
    },
    setArchived: async (archived, reason) => {
      operations.push(['setArchived', archived, reason]);
      thread.archived = archived;
    },
    setLocked: async (locked, reason) => {
      operations.push(['setLocked', locked, reason]);
      thread.locked = locked;
    },
  };
  const client = {
    channels: {
      cache: new Map([[THREAD_ID, thread]]),
      fetch: async () => assert.fail('cached thread should not be fetched'),
    },
  };

  const result = await archiveWarCounterRoom({
    client,
    logger,
    channelId: THREAD_ID,
    guildId: GUILD_ID,
    reason: 'test archive',
  });

  assert.deepEqual(result, { success: true, channelId: THREAD_ID });
  assert.deepEqual(operations, [
    ['setName', '[Archived] counter-room', 'test archive'],
    ['setArchived', true, 'test archive'],
    ['setLocked', true, 'test archive'],
  ]);
});

test('archiveWarCounterRoom is idempotent for an already archived and locked thread', async () => {
  const logger = createLogger();
  const thread = {
    id: THREAD_ID,
    guildId: GUILD_ID,
    name: '[Archived] counter-room',
    archived: true,
    locked: true,
    isThread: () => true,
    setName: async () => assert.fail('already-prefixed thread should not be renamed'),
    setArchived: async () => assert.fail('already-archived thread should not be archived again'),
    setLocked: async () => assert.fail('already-locked thread should not be locked again'),
  };
  const client = {
    channels: {
      cache: new Map([[THREAD_ID, thread]]),
      fetch: async () => null,
    },
  };

  const result = await archiveWarCounterRoom({
    client,
    logger,
    channelId: THREAD_ID,
    guildId: GUILD_ID,
  });

  assert.deepEqual(result, { success: true, channelId: THREAD_ID });
});

test('archiveWarCounterRoom sanitizes user-facing title prefixes before renaming', async () => {
  let renamedTo;
  const thread = {
    id: THREAD_ID,
    guildId: GUILD_ID,
    name: 'counter-room',
    archived: true,
    locked: true,
    isThread: () => true,
    setName: async (name) => { renamedTo = name; },
  };

  await archiveWarCounterRoom({
    client: { channels: { cache: new Map([[THREAD_ID, thread]]) } },
    logger: createLogger(),
    channelId: THREAD_ID,
    guildId: GUILD_ID,
    titlePrefix: '[Done]\n  ',
  });

  assert.equal(renamedTo, '[Done] counter-room');
});

test('archiveWarCounterRoom reports missing, unavailable, and non-thread targets', async () => {
  const logger = createLogger();
  const unavailableClient = {
    channels: {
      cache: new Map(),
      fetch: async () => {
        throw new Error('Missing Access');
      },
    },
  };

  assert.deepEqual(
    await archiveWarCounterRoom({ client: unavailableClient, logger, channelId: '', guildId: GUILD_ID }),
    { success: false, reason: 'missing_channel' },
  );
  assert.deepEqual(
    await archiveWarCounterRoom({ client: unavailableClient, logger, channelId: THREAD_ID, guildId: GUILD_ID }),
    { success: false, reason: 'channel_unavailable' },
  );

  const nonThreadClient = {
    channels: {
      cache: new Map([[THREAD_ID, { guildId: GUILD_ID, type: 'GuildText', isThread: () => false }]]),
      fetch: async () => null,
    },
  };

  assert.deepEqual(
    await archiveWarCounterRoom({ client: nonThreadClient, logger, channelId: THREAD_ID, guildId: GUILD_ID }),
    { success: false, reason: 'not_thread' },
  );
});

test('archiveWarCounterRoom rejects a thread from another guild', async () => {
  const logger = createLogger();
  const thread = {
    guildId: '323456789012345678',
    name: 'counter-room',
    isThread: () => true,
  };
  const client = {
    channels: {
      cache: new Map([[THREAD_ID, thread]]),
      fetch: async () => null,
    },
  };

  assert.deepEqual(
    await archiveWarCounterRoom({ client, logger, channelId: THREAD_ID, guildId: GUILD_ID }),
    { success: false, reason: 'wrong_guild' },
  );
});
