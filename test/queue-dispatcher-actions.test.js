import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueDispatcher } from '../src/services/QueueDispatcher.js';
import { createLogger } from './helpers.js';

function createBaseClient() {
  return {
    channels: {
      cache: new Map(),
      fetch: async () => null,
    },
    guilds: {
      cache: new Map(),
      fetch: async () => null,
    },
  };
}

test('QueueDispatcher rejects invalid and unsupported queue actions', async () => {
  const logger = createLogger();
  const dispatcher = new QueueDispatcher({
    client: createBaseClient(),
    logger,
    guildId: 'guild-1',
  });

  assert.deepEqual(await dispatcher.dispatch({ id: 'queue-1' }), {
    success: false,
    reason: 'invalid_action',
  });
  assert.deepEqual(await dispatcher.dispatch({ id: 'queue-2', action: 'NOPE' }), {
    success: false,
    reason: 'unsupported_action',
  });
});

test('QueueDispatcher archives a mapped war-counter thread', async () => {
  const logger = createLogger();
  const operations = [];
  const thread = {
    id: 'thread-1',
    name: 'counter-room',
    archived: false,
    locked: false,
    isThread: () => true,
    setName: async (name) => {
      operations.push(['setName', name]);
      thread.name = name;
    },
    setArchived: async (archived) => {
      operations.push(['setArchived', archived]);
      thread.archived = archived;
    },
    setLocked: async (locked) => {
      operations.push(['setLocked', locked]);
      thread.locked = locked;
    },
  };
  const client = createBaseClient();
  client.channels.cache.set('thread-1', thread);
  const sourceChannelMap = new Map([['war_counter:77', 'thread-1']]);
  const dispatcher = new QueueDispatcher({
    client,
    logger,
    guildId: 'guild-1',
    sourceChannelMap,
  });

  const result = await dispatcher.dispatch({
    id: 'queue-1',
    action: 'WAR_ROOM_ARCHIVE',
    payload: {
      source: { type: 'war_counter', id: 77 },
      archive: { title_prefix: '[Done] ' },
    },
  });

  assert.deepEqual(result, { success: true });
  assert.deepEqual(operations, [
    ['setName', '[Done] counter-room'],
    ['setArchived', true],
    ['setLocked', true],
  ]);
});

test('QueueDispatcher removes all non-everyone roles for alliance departures', async () => {
  const logger = createLogger();
  let removedRoleIds = null;
  const roles = [
    { id: 'guild-1' },
    { id: 'member-role' },
    { id: 'applicant-role' },
  ];
  const member = {
    roles: {
      cache: {
        filter: (predicate) => {
          const filtered = roles.filter(predicate);
          return {
            map: (mapper) => filtered.map(mapper),
          };
        },
      },
      remove: async (roleIds) => {
        removedRoleIds = roleIds;
      },
    },
  };
  const guild = {
    id: 'guild-1',
    members: {
      fetch: async (discordId) => {
        assert.equal(discordId, 'user-1');
        return member;
      },
    },
  };
  const client = createBaseClient();
  client.guilds.cache.set('guild-1', guild);
  const dispatcher = new QueueDispatcher({
    client,
    logger,
    guildId: 'guild-1',
  });

  const result = await dispatcher.dispatch({
    id: 'queue-1',
    action: 'ALLIANCE_ROLE_REMOVAL',
    payload: {
      discord_id: 'user-1',
      nation_id: 123,
    },
  });

  assert.deepEqual(result, { success: true });
  assert.deepEqual(removedRoleIds, ['member-role', 'applicant-role']);
});
