import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueDispatcher } from '../src/services/QueueDispatcher.js';

function createLogger() {
  const entries = { info: [], warn: [], error: [], debug: [] };

  return {
    entries,
    info: (...args) => entries.info.push(args),
    warn: (...args) => entries.warn.push(args),
    error: (...args) => entries.error.push(args),
    debug: (...args) => entries.debug.push(args),
  };
}

function createWarRoomContext({ onThreadSend } = {}) {
  const logger = createLogger();
  const sentMessages = [];

  const thread = {
    id: 'thread-123',
    send: async (payload) => {
      sentMessages.push(payload);

      if (onThreadSend) {
        return onThreadSend(payload);
      }

      return { id: `msg-${sentMessages.length}` };
    },
  };

  const forum = {
    isThreadOnly: () => true,
    threads: {
      create: async () => thread,
    },
  };

  const client = {
    channels: {
      cache: new Map([['forum-1', forum]]),
      fetch: async () => null,
    },
    guilds: {
      cache: new Map(),
      fetch: async () => null,
    },
  };

  const dispatcher = new QueueDispatcher({
    client,
    logger,
    guildId: 'guild-1',
    apiService: {
      attachWarCounterChannel: async () => undefined,
    },
  });

  return { dispatcher, logger, sentMessages };
}

test('WAR_ROOM_CREATE with defense_role_id attempts role ping for war_counter and continues on ping failure', async () => {
  let pingAttempts = 0;
  const { dispatcher, logger, sentMessages } = createWarRoomContext({
    onThreadSend: (payload) => {
      if (payload?.content === '<@&987654321>') {
        pingAttempts += 1;
        throw new Error('Missing Permissions');
      }
      return { id: 'ok' };
    },
  });

  const result = await dispatcher.dispatch({
    id: 'cmd-1',
    action: 'WAR_ROOM_CREATE',
    created_at: '2026-02-27T00:00:00Z',
    payload: {
      forum_channel_id: 'forum-1',
      source: { type: 'war_counter', id: 77 },
      target: { leader_name: 'Target Leader', nation_name: 'Target Nation' },
      defense_role_id: '987654321',
    },
  });

  assert.equal(result.success, true);
  assert.equal(pingAttempts, 1);
  assert.equal(sentMessages.some((message) => message?.content === '<@&987654321>'), true);
  assert.equal(
    logger.entries.warn.some(([message]) => message === 'Failed to send WAR_ROOM_CREATE defense role ping; continuing'),
    true,
  );
});

test('WAR_ROOM_CREATE without defense_role_id does not attempt role ping', async () => {
  const { dispatcher, logger, sentMessages } = createWarRoomContext();

  const result = await dispatcher.dispatch({
    id: 'cmd-2',
    action: 'WAR_ROOM_CREATE',
    created_at: '2026-02-27T00:00:00Z',
    payload: {
      forum_channel_id: 'forum-1',
      source: { type: 'war_counter', id: 88 },
      target: { leader_name: 'Target Leader', nation_name: 'Target Nation' },
    },
  });

  assert.equal(result.success, true);
  assert.equal(sentMessages.some((message) => /^<@&/.test(message?.content ?? '')), false);
  assert.equal(
    logger.entries.warn.some(([message]) => message === 'Failed to send WAR_ROOM_CREATE defense role ping; continuing'),
    false,
  );
});
