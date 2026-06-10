import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveWarCounterRoom,
  buildSourceChannelKey,
  resolveWarCounterChannelIdFromCounter,
} from '../src/utils/warCounterRooms.js';
import { createLogger } from './helpers.js';

test('buildSourceChannelKey normalizes valid source data and rejects incomplete input', () => {
  assert.equal(buildSourceChannelKey(' War_Counter ', ' 42 '), 'war_counter:42');
  assert.equal(buildSourceChannelKey('war_plan', 17), 'war_plan:17');
  assert.equal(buildSourceChannelKey('', 17), null);
  assert.equal(buildSourceChannelKey('war_counter', ''), null);
  assert.equal(buildSourceChannelKey(null, 17), null);
});

test('resolveWarCounterChannelIdFromCounter returns the first populated channel-like id', () => {
  assert.equal(
    resolveWarCounterChannelIdFromCounter({
      discord_channel_id: ' ',
      discord_thread_id: null,
      channel_id: ' channel-123 ',
      thread_id: 'thread-456',
    }),
    'channel-123',
  );

  assert.equal(resolveWarCounterChannelIdFromCounter({ thread_id: 987 }), '987');
  assert.equal(resolveWarCounterChannelIdFromCounter({}), null);
  assert.equal(resolveWarCounterChannelIdFromCounter(null), null);
});

test('archiveWarCounterRoom renames, archives, and locks an active thread', async () => {
  const logger = createLogger();
  const operations = [];
  const thread = {
    id: 'thread-1',
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
      cache: new Map([['thread-1', thread]]),
      fetch: async () => assert.fail('cached thread should not be fetched'),
    },
  };

  const result = await archiveWarCounterRoom({
    client,
    logger,
    channelId: 'thread-1',
    reason: 'test archive',
  });

  assert.deepEqual(result, { success: true, channelId: 'thread-1' });
  assert.deepEqual(operations, [
    ['setName', '[Archived] counter-room', 'test archive'],
    ['setArchived', true, 'test archive'],
    ['setLocked', true, 'test archive'],
  ]);
});

test('archiveWarCounterRoom is idempotent for an already archived and locked thread', async () => {
  const logger = createLogger();
  const thread = {
    id: 'thread-1',
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
      cache: new Map([['thread-1', thread]]),
      fetch: async () => null,
    },
  };

  const result = await archiveWarCounterRoom({ client, logger, channelId: 'thread-1' });

  assert.deepEqual(result, { success: true, channelId: 'thread-1' });
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
    await archiveWarCounterRoom({ client: unavailableClient, logger, channelId: '' }),
    { success: false, reason: 'missing_channel' },
  );
  assert.deepEqual(
    await archiveWarCounterRoom({ client: unavailableClient, logger, channelId: 'thread-404' }),
    { success: false, reason: 'channel_unavailable' },
  );

  const nonThreadClient = {
    channels: {
      cache: new Map([['text-1', { type: 'GuildText', isThread: () => false }]]),
      fetch: async () => null,
    },
  };

  assert.deepEqual(
    await archiveWarCounterRoom({ client: nonThreadClient, logger, channelId: 'text-1' }),
    { success: false, reason: 'not_thread' },
  );
});
