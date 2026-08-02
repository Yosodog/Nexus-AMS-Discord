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

const GUILD_ID = '123456789012345678';
const THREAD_ID = '223456789012345678';
const MEMBER_ID = '523456789012345678';

test('QueueDispatcher rejects invalid and unsupported queue actions', async () => {
  const logger = createLogger();
  const dispatcher = new QueueDispatcher({
    client: createBaseClient(),
    logger,
    guildId: GUILD_ID,
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

test('QueueDispatcher archives a persisted war-counter thread', async () => {
  const logger = createLogger();
  const operations = [];
  const thread = {
    id: THREAD_ID,
    guildId: GUILD_ID,
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
  client.channels.cache.set(THREAD_ID, thread);
  const dispatcher = new QueueDispatcher({
    client,
    logger,
    guildId: GUILD_ID,
    apiService: { getWarCounter: async () => ({ counter: { discord_channel_id: THREAD_ID } }) },
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

test('QueueDispatcher ignores a stale archive payload channel in favor of the current Nexus record', async () => {
  const staleThreadId = '323456789012345678';
  const operations = [];
  const makeThread = (id) => ({
    id,
    guildId: GUILD_ID,
    name: 'counter-room',
    archived: false,
    locked: false,
    isThread: () => true,
    setName: async () => operations.push([id, 'name']),
    setArchived: async () => operations.push([id, 'archive']),
    setLocked: async () => operations.push([id, 'lock']),
  });
  const client = createBaseClient();
  client.channels.cache.set(staleThreadId, makeThread(staleThreadId));
  client.channels.cache.set(THREAD_ID, makeThread(THREAD_ID));
  const dispatcher = new QueueDispatcher({
    client,
    logger: createLogger(),
    guildId: GUILD_ID,
    apiService: { getWarCounter: async () => ({ counter: { discord_channel_id: THREAD_ID } }) },
  });

  const result = await dispatcher.dispatch({
    id: 'queue-stale',
    action: 'WAR_ROOM_ARCHIVE',
    payload: {
      discord_channel_id: staleThreadId,
      source: { type: 'war_counter', id: 77 },
    },
  });

  assert.equal(result.success, true);
  assert.equal(operations.every(([id]) => id === THREAD_ID), true);
});

test('QueueDispatcher removes all non-everyone roles for alliance departures', async () => {
  const logger = createLogger();
  let removedRoleIds = null;
  const roles = new Map([
    [GUILD_ID, { id: GUILD_ID }],
    ['member-role', { id: 'member-role', editable: true, managed: false }],
    ['applicant-role', { id: 'applicant-role', editable: true, managed: false }],
  ]);
  const member = {
    roles: {
      cache: roles,
      remove: async (roleIds) => {
        removedRoleIds = roleIds;
        roleIds.forEach((roleId) => roles.delete(roleId));
      },
    },
  };
  const guild = {
    id: GUILD_ID,
    members: {
      fetch: async (discordId) => {
        assert.equal(discordId, MEMBER_ID);
        return member;
      },
    },
  };
  const client = createBaseClient();
  client.guilds.cache.set(GUILD_ID, guild);
  const dispatcher = new QueueDispatcher({
    client,
    logger,
    guildId: GUILD_ID,
  });

  const result = await dispatcher.dispatch({
    id: 'queue-1',
    action: 'ALLIANCE_ROLE_REMOVAL',
    payload: {
      discord_id: MEMBER_ID,
      nation_id: 123,
    },
  });

  assert.deepEqual(result, { success: true });
  assert.deepEqual(removedRoleIds, ['member-role', 'applicant-role']);
});

test('QueueDispatcher reports uneditable roles but succeeds when no editable roles remain', async () => {
  const logger = createLogger();
  const roles = new Map([
    [GUILD_ID, { id: GUILD_ID }],
    ['managed-role', { id: 'managed-role', editable: false, managed: true }],
    ['editable-role', { id: 'editable-role', editable: true, managed: false }],
  ]);
  const member = {
    roles: {
      cache: roles,
      remove: async (ids) => ids.forEach((id) => roles.delete(id)),
    },
  };
  const guild = { id: GUILD_ID, members: { fetch: async () => member } };
  const client = createBaseClient();
  client.guilds.cache.set(GUILD_ID, guild);
  const dispatcher = new QueueDispatcher({ client, logger, guildId: GUILD_ID });

  const result = await dispatcher.dispatch({
    id: 'queue-uneditable',
    action: 'ALLIANCE_ROLE_REMOVAL',
    payload: { discord_id: '523456789012345678' },
  });

  assert.deepEqual(result, { success: true });
  assert.deepEqual(Array.from(roles.keys()), [GUILD_ID, 'managed-role']);
  assert.equal(
    logger.entries.warn.some(([message]) => message.includes('managed or uneditable')),
    true,
  );
});

test('QueueDispatcher fails role removal when an editable role remains assigned', async () => {
  const roles = new Map([
    [GUILD_ID, { id: GUILD_ID }],
    ['editable-role', { id: 'editable-role', editable: true, managed: false }],
  ]);
  const member = { roles: { cache: roles, remove: async () => {} } };
  const guild = { id: GUILD_ID, members: { fetch: async () => member } };
  const client = createBaseClient();
  client.guilds.cache.set(GUILD_ID, guild);
  const dispatcher = new QueueDispatcher({ client, logger: createLogger(), guildId: GUILD_ID });

  const result = await dispatcher.dispatch({
    id: 'queue-remnant',
    action: 'ALLIANCE_ROLE_REMOVAL',
    payload: { discord_id: '523456789012345678' },
  });

  assert.deepEqual(result, { success: false, reason: 'roles_remain' });
});

test('QueueDispatcher delivers richly formatted alert actions with inert default mentions', async () => {
  const sent = [];
  const channelId = '323456789012345678';
  const channel = {
    id: channelId,
    guildId: GUILD_ID,
    isTextBased: () => true,
    send: async (payload) => {
      sent.push(payload);
      return { id: `message-${sent.length}` };
    },
  };
  const client = createBaseClient();
  client.channels.cache.set(channelId, channel);
  const dispatcher = new QueueDispatcher({ client, logger: createLogger(), guildId: GUILD_ID });
  const military = {
    soldiers: 1000,
    tanks: 200,
    aircraft: 50,
    ships: 10,
    spies: 20,
    missiles: 3,
    nukes: 1,
  };

  const results = await Promise.all([
    dispatcher.dispatch({
      id: 'departure-1',
      action: 'ALLIANCE_DEPARTURE',
      created_at: '2026-07-10T00:00:00Z',
      payload: {
        channel_id: channelId,
        left_at: '2026-07-09T00:00:00Z',
        nation: {
          nation_name: 'Former Nation',
          leader_name: 'Former Leader',
          links: { nation: 'https://politicsandwar.com/nation/id=1' },
        },
        previous_alliance: { name: 'Old Alliance', acronym: 'OLD' },
        new_alliance: { name: 'New Alliance', acronym: 'NEW' },
      },
    }),
    dispatcher.dispatch({
      id: 'inactive-1',
      action: 'INACTIVITY_ALERT',
      created_at: '2026-07-10T00:00:00Z',
      payload: {
        channel_id: channelId,
        discord_user_id: '423456789012345678',
        leader_name: 'Sleepy Leader',
        nation_name: 'Sleepy Nation',
        nation_id: 55,
        last_active_at: '2026-07-08T00:00:00Z',
        threshold_hours: 48,
      },
    }),
    dispatcher.dispatch({
      id: 'beige-turn-1',
      action: 'BEIGE_ALERT',
      created_at: '2026-07-10T00:00:00Z',
      payload: {
        channel_id: channelId,
        event_type: 'beige_exit_window',
        window: 'upcoming',
        turn_change_at: '2026-07-10T02:00:00Z',
        nation_count: 1,
        nations: [{
          id: 99,
          nation_name: 'Target Nation',
          leader_name: 'Target Leader',
          score: 1234.56,
          cities: 20,
          beige_turns: 1,
          alliance: { name: 'Target Alliance' },
          links: {
            nation: 'https://politicsandwar.com/nation/id=99',
            alliance: 'https://politicsandwar.com/alliance/id=2',
          },
          military,
        }],
      },
    }),
    dispatcher.dispatch({
      id: 'beige-exit-1',
      action: 'BEIGE_ALERT',
      created_at: '2026-07-10T00:00:00Z',
      payload: {
        channel_id: channelId,
        event_type: 'beige_exit',
        detected_at: '2026-07-10T01:00:00Z',
        previous_beige_turns: 2,
        nation: {
          id: 99,
          nation_name: 'Target Nation',
          leader_name: 'Target Leader',
          score: 1234.56,
          cities: 20,
          alliance: { name: 'Target Alliance', acronym: 'TA' },
          links: {
            nation: 'https://politicsandwar.com/nation/id=99',
            alliance: 'https://politicsandwar.com/alliance/id=2',
          },
          military,
        },
      },
    }),
  ]);

  assert.equal(results.every(({ success }) => success), true);
  assert.equal(sent.length, 4);
  assert.equal(sent.every((payload) => payload.enforceNonce && payload.nonce.length <= 25), true);
  assert.deepEqual(sent[0].allowedMentions, { parse: [], repliedUser: false });
  assert.deepEqual(sent[1].allowedMentions, { users: ['423456789012345678'] });

  const departureEmbed = sent[0].embeds[0].toJSON();
  assert.match(departureEmbed.title, /Alliance Departure — Former Nation/);
  assert.match(departureEmbed.description, /Former Leader.*left.*Old Alliance/);
  assert.equal(departureEmbed.fields, undefined);

  const inactivityEmbed = sent[1].embeds[0].toJSON();
  assert.match(inactivityEmbed.title, /Inactivity Warning — Sleepy Nation/);
  assert.match(inactivityEmbed.description, /last active <t:/);
  assert.deepEqual(inactivityEmbed.fields.map((field) => field.name), ['Inactive for', 'Alert threshold']);

  assert.match(sent[2].content, /## 🟨 Beige Watch — Expected to Leave Beige This Turn/);
  assert.match(sent[2].content, /\[Target Nation\]\(https:\/\/politicsandwar\.com\/nation\/id=99\)/);
  assert.match(sent[2].content, /\*\*Part:\*\* 1 of 1/);
  assert.doesNotMatch(sent[2].content, /🪖|🛡️|✈️|🚢|🕵️|🎯|☢️/);

  const beigeExitEmbed = sent[3].embeds[0].toJSON();
  assert.match(beigeExitEmbed.title, /Beige Exit — Target Nation/);
  assert.match(beigeExitEmbed.description, /no longer protected by beige/);
  assert.deepEqual(beigeExitEmbed.fields.map((field) => field.name), [
    'Alliance', 'Score', 'Cities', 'Previous beige', 'Military',
  ]);
  assert.equal(beigeExitEmbed.footer, undefined);
});

test('BEIGE_ALERT paginates complete safe nation blocks within Discord limits', async () => {
  const sent = [];
  const channelId = '323456789012345678';
  const channel = {
    id: channelId,
    guildId: GUILD_ID,
    isTextBased: () => true,
    send: async (payload) => { sent.push(payload); return { id: `beige-${sent.length}` }; },
  };
  const client = createBaseClient();
  client.channels.cache.set(channelId, channel);
  const dispatcher = new QueueDispatcher({ client, logger: createLogger(), guildId: GUILD_ID });
  const nations = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    nation_name: index === 0 ? 'Target ](https://evil.example)' : `Long Target Nation ${index + 1} ${'X'.repeat(55)}`,
    leader_name: `Leader ${index + 1}`,
    score: 1200 + index,
    cities: 20,
    beige_turns: 1,
    alliance: { name: `Alliance ${index + 1}` },
    links: {
      nation: index === 0 ? 'javascript:alert(1)' : `https://politicsandwar.com/nation/id=${index + 1}`,
      alliance: `https://politicsandwar.com/alliance/id=${index + 1}`,
    },
    military: { soldiers: 1000, tanks: 200, aircraft: 50, ships: 10, spies: 20, missiles: 3, nukes: 1 },
  }));

  const result = await dispatcher.dispatch({
    id: 'beige-many',
    action: 'BEIGE_ALERT',
    created_at: '2026-07-10T00:00:00Z',
    payload: {
      channel_id: channelId,
      event_type: 'upcoming_turn_exit',
      turn_change_at: '2026-07-10T02:00:00Z',
      nation_count: nations.length,
      nations,
    },
  });

  assert.deepEqual(result, { success: true });
  assert.ok(sent.length > 1);
  assert.ok(sent.every((message) => message.content.length <= 2_000));
  assert.ok(sent.every((message) => /## 🟨 Beige Watch/.test(message.content)));
  assert.ok(sent.every((message) => /\*\*Part:\*\* \d+ of \d+/.test(message.content)));
  assert.equal(sent.reduce((count, message) => count + (message.content.match(/^### /gm)?.length ?? 0), 0), nations.length);
  assert.doesNotMatch(sent.map((message) => message.content).join('\n'), /\]\(https:\/\/evil\.example\)/);
});

test('QueueDispatcher rejects foreign-guild channels without sending', async () => {
  let sends = 0;
  const client = createBaseClient();
  const foreignChannelId = '723456789012345678';
  client.channels.cache.set(foreignChannelId, {
    guildId: '999999999999999999',
    isTextBased: () => true,
    send: async () => { sends += 1; },
  });
  const dispatcher = new QueueDispatcher({ client, logger: createLogger(), guildId: GUILD_ID });

  const result = await dispatcher.dispatch({
    id: 'foreign-1',
    action: 'WAR_ALERT',
    payload: { channel_id: foreignChannelId },
  });

  assert.deepEqual(result, { success: false, reason: 'channel_unavailable' });
  assert.equal(sends, 0);
});
