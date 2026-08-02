import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueDispatcher } from '../src/services/QueueDispatcher.js';

const GUILD_ID = '123456789012345678';
const FORUM_ID = '223456789012345678';
const THREAD_ID = '323456789012345678';
const ROLE_ID = '423456789012345678';

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

function createWarRoomContext({ onThreadSend, onThreadCreate, onCheckpoint, onAttach } = {}) {
  const logger = createLogger();
  const sentMessages = [];

  const thread = {
    id: THREAD_ID,
    guildId: GUILD_ID,
    parentId: FORUM_ID,
    isThread: () => true,
    send: async (payload) => {
      sentMessages.push(payload);

      if (onThreadSend) {
        return onThreadSend(payload);
      }

      return { id: `msg-${sentMessages.length}` };
    },
  };

  const forum = {
    id: FORUM_ID,
    guildId: GUILD_ID,
    isThreadOnly: () => true,
    threads: {
      create: async (payload) => {
        if (onThreadCreate) return onThreadCreate(payload, thread);
        return thread;
      },
    },
  };

  const client = {
    channels: {
      cache: new Map([[FORUM_ID, forum], [THREAD_ID, thread]]),
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
    guildId: GUILD_ID,
    apiService: {
      attachWarCounterChannel: async (payload) => onAttach?.(payload),
      checkpointDiscordQueue: async (...args) => onCheckpoint?.(...args),
    },
  });

  return { dispatcher, logger, sentMessages, thread };
}

test('WAR_ROOM_CREATE checkpoints before attaching and sending follow-up steps', async () => {
  const events = [];
  const { dispatcher } = createWarRoomContext({
    onThreadCreate: (_payload, thread) => {
      events.push('create');
      return thread;
    },
    onCheckpoint: () => events.push('checkpoint'),
    onAttach: () => events.push('attach'),
    onThreadSend: () => events.push('send'),
  });

  const result = await dispatcher.dispatch({
    id: '723456789012345678',
    action: 'WAR_ROOM_CREATE',
    lease_token: 'lease-token',
    payload: {
      forum_channel_id: FORUM_ID,
      source: { type: 'war_counter', id: 77 },
      target: { nation_name: 'Target Nation' },
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(events.slice(0, 3), ['create', 'checkpoint', 'attach']);
  assert.equal(events.includes('send'), true);
});

test('WAR_ROOM_CREATE resumes the checkpointed thread and rejects a wrong forum parent', async () => {
  let creates = 0;
  const { dispatcher } = createWarRoomContext({ onThreadCreate: () => { creates += 1; } });
  const base = {
    id: '723456789012345679',
    action: 'WAR_ROOM_CREATE',
    lease_token: 'lease-token',
    result: { discord_channel_id: THREAD_ID },
    payload: {
      forum_channel_id: FORUM_ID,
      source: { type: 'war_counter', id: 77 },
      target: { nation_name: 'Target Nation' },
    },
  };

  assert.equal((await dispatcher.dispatch(base)).success, true);
  assert.equal(creates, 0);

  const context = createWarRoomContext();
  context.thread.parentId = '999999999999999999';
  assert.deepEqual(await context.dispatcher.dispatch(base), { success: false, reason: 'invalid_checkpoint' });
});

test('WAR_ROOM_CREATE refuses a malformed persisted checkpoint instead of creating a duplicate', async () => {
  let creates = 0;
  const { dispatcher } = createWarRoomContext({ onThreadCreate: () => { creates += 1; } });
  const result = await dispatcher.dispatch({
    id: '723456789012345682',
    action: 'WAR_ROOM_CREATE',
    lease_token: 'lease-token',
    result: { discord_channel_id: 323456789012345678 },
    payload: {
      forum_channel_id: FORUM_ID,
      source: { type: 'war_counter', id: 77 },
      target: { nation_name: 'Target Nation' },
    },
  });

  assert.deepEqual(result, { success: false, reason: 'invalid_checkpoint' });
  assert.equal(creates, 0);
});

test('WAR_ROOM_CREATE reports reconciliation when its durable checkpoint fails', async () => {
  const { dispatcher, logger } = createWarRoomContext({
    onCheckpoint: () => { throw new Error('Nexus unavailable'); },
  });

  const result = await dispatcher.dispatch({
    id: '723456789012345680',
    action: 'WAR_ROOM_CREATE',
    lease_token: 'lease-token',
    payload: {
      forum_channel_id: FORUM_ID,
      source: { type: 'war_counter', id: 77 },
      target: { nation_name: 'Target Nation' },
    },
  });

  assert.deepEqual(result, { success: false, reason: 'checkpoint_failed' });
  assert.equal(
    logger.entries.error.some(([, details]) => details?.reconciliationRequired === true),
    true,
  );
});

test('WAR_ROOM_CREATE fails after checkpoint when Nexus counter attachment fails', async () => {
  let sends = 0;
  const { dispatcher } = createWarRoomContext({
    onAttach: () => { throw new Error('attach rejected'); },
    onThreadSend: () => { sends += 1; },
  });

  const result = await dispatcher.dispatch({
    id: '723456789012345681',
    action: 'WAR_ROOM_CREATE',
    lease_token: 'lease-token',
    payload: {
      forum_channel_id: FORUM_ID,
      source: { type: 'war_counter', id: 77 },
      target: { nation_name: 'Target Nation' },
    },
  });

  assert.deepEqual(result, { success: false, reason: 'counter_attach_failed' });
  assert.equal(sends, 0);
});

test('WAR_ROOM_CREATE fails for retry when the required defense role ping fails', async () => {
  let pingAttempts = 0;
  const { dispatcher, logger, sentMessages } = createWarRoomContext({
    onThreadSend: (payload) => {
      if (payload?.content?.includes(`<@&${ROLE_ID}>`)) {
        pingAttempts += 1;
        throw new Error('Missing Permissions');
      }
      return { id: 'ok' };
    },
  });

  const result = await dispatcher.dispatch({
    id: '823456789012345678',
    action: 'WAR_ROOM_CREATE',
    lease_token: 'lease-token',
    created_at: '2026-02-27T00:00:00Z',
    payload: {
      forum_channel_id: FORUM_ID,
      source: { type: 'war_counter', id: 77 },
      target: { leader_name: 'Target Leader', nation_name: 'Target Nation' },
      defense_role_id: ROLE_ID,
    },
  });

  assert.equal(result.success, false);
  assert.equal(pingAttempts, 1);
  assert.equal(sentMessages.some((message) => message?.content?.includes(`<@&${ROLE_ID}>`)), true);
});

test('WAR_ROOM_CREATE without defense_role_id does not attempt role ping', async () => {
  let starterPayload;
  const { dispatcher, logger, sentMessages } = createWarRoomContext({
    onThreadCreate: (payload, thread) => {
      starterPayload = payload;
      return thread;
    },
  });

  const result = await dispatcher.dispatch({
    id: '923456789012345678',
    action: 'WAR_ROOM_CREATE',
    lease_token: 'lease-token',
    created_at: '2026-02-27T00:00:00Z',
    payload: {
      forum_channel_id: FORUM_ID,
      source: { type: 'war_counter', id: 88 },
      target: {
        id: 99,
        leader_name: 'Target Leader',
        nation_name: 'Target Nation',
        score: 1234,
        cities: 20,
        offensive_wars: 1,
        defensive_wars: 2,
        beige_turns: 0,
        alliance: { name: 'Target Alliance', acronym: 'TA' },
        military: { soldiers: 1000, tanks: 200, aircraft: 50, ships: 10, spies: 20, missiles: 1, nukes: 0 },
      },
      attacked_member: {
        discord_id: '523456789012345678',
        leader_name: 'Defending Leader',
        nation_name: 'Defending Nation',
        nation_id: 101,
        links: { nation: 'https://politicsandwar.com/nation/id=101' },
      },
      assigned_members: [{
        discord_id: '623456789012345678',
        leader_name: 'Friendly Leader',
        nation_name: 'Friendly Nation',
        nation_id: 102,
        score: 1100,
        cities: 19,
        match_score: 95,
        offensive_wars: 0,
        defensive_wars: 1,
        role: 'counter',
        links: { nation: 'https://politicsandwar.com/nation/id=102' },
      }],
      attack_type: { key: 'raid', label: 'Raid' },
      reason: 'Defensive counter',
      links: { target_nation: 'https://politicsandwar.com/nation/id=99' },
    },
  });

  assert.equal(result.success, true);
  assert.equal(sentMessages.some((message) => message?.content?.includes('<@&')), false);
  assert.equal(sentMessages.every((message) => message.enforceNonce === true && message.nonce.length <= 25), true);
  assert.match(starterPayload.message.content, /## War Room Opened/);
  const starterEmbed = starterPayload.message.embeds[0].toJSON();
  assert.match(starterEmbed.title, /Target Brief — Target Nation/);
  assert.deepEqual(starterEmbed.fields.map((field) => field.name), [
    'Objective', 'Target status', 'Military',
  ]);
  assert.match(starterEmbed.fields[0].value, /Attack type:\*\* Raid/);
  const mentionMessage = sentMessages.find((message) => /Participant Notifications/.test(message.content));
  const assignmentMessage = sentMessages.find((message) => /## Assignments/.test(message.content));
  assert.ok(mentionMessage);
  assert.ok(assignmentMessage);
  assert.match(mentionMessage.content, /<@523456789012345678>.*<@623456789012345678>/s);
  assert.deepEqual(mentionMessage.allowedMentions.users.sort(), [
    '523456789012345678', '623456789012345678',
  ]);
  assert.match(assignmentMessage.content, /### Counters/);
  assert.match(assignmentMessage.content, /\[Friendly Nation\]\(https:\/\/politicsandwar\.com\/nation\/id=102\)/);
  assert.match(assignmentMessage.content, /### Instructions/);
  assert.ok(sentMessages.every((message) => (message.content?.length ?? 0) <= 2_000));
  assert.equal(
    logger.entries.warn.some(([message]) => message === 'Failed to send WAR_ROOM_CREATE defense role ping; continuing'),
    false,
  );
});

test('WAR_ROOM_CREATE caps displayed roster detail without dropping participant notifications', async () => {
  const { dispatcher, sentMessages } = createWarRoomContext();
  const assignedMembers = Array.from({ length: 27 }, (_, index) => ({
    discord_id: `${50_000_000_000_000_000n + BigInt(index)}`,
    nation_id: index + 1,
    nation_name: `Friendly Nation ${index + 1}`,
    leader_name: `Leader ${index + 1}`,
    role: 'counter',
  }));

  const result = await dispatcher.dispatch({
    id: '923456789012345679',
    action: 'WAR_ROOM_CREATE',
    lease_token: 'lease-token',
    payload: {
      forum_channel_id: FORUM_ID,
      source: { type: 'war_plan', id: 90, url: 'https://nexus.example/war-plans/90' },
      target: { leader_name: 'Target Leader', nation_name: 'Target Nation' },
      assigned_members: assignedMembers,
      reason: 'Defensive counter',
    },
  });

  assert.deepEqual(result, { success: true });
  const notificationContent = sentMessages
    .filter((message) => /Participant Notifications/.test(message.content))
    .map((message) => message.content)
    .join('\n');
  const assignmentContent = sentMessages
    .filter((message) => /## Assignments/.test(message.content))
    .map((message) => message.content)
    .join('\n');
  assert.match(notificationContent, new RegExp(`<@${assignedMembers.at(-1).discord_id}>`));
  assert.match(assignmentContent, /2 additional assignment entries were omitted/);
  assert.match(assignmentContent, /Open the source plan for the complete roster/);
  assert.ok(sentMessages.every((message) => (message.content?.length ?? 0) <= 2_000));
});

test('WAR_ALERT retries once when Discord returns retry_after metadata', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (callback, _delay, ...args) => {
    callback(...args);
    return 0;
  });

  const logger = createLogger();
  let sendAttempts = 0;
  let sentPayload = null;

  const channel = {
    guildId: GUILD_ID,
    isTextBased: () => true,
    send: async (payload) => {
      sendAttempts += 1;

      if (sendAttempts === 1) {
        const error = new Error('Rate limited');
        error.retry_after = 0.001;
        throw error;
      }

      sentPayload = payload;
      return { id: 'message-1' };
    },
  };

  const dispatcher = new QueueDispatcher({
    client: {
      channels: {
        cache: new Map([['723456789012345678', channel]]),
        fetch: async () => null,
      },
      guilds: {
        cache: new Map(),
        fetch: async () => null,
      },
    },
    logger,
    guildId: GUILD_ID,
  });

  const result = await dispatcher.dispatch({
    id: 'cmd-3',
    action: 'WAR_ALERT',
    created_at: '2026-02-27T00:00:00Z',
    payload: {
      channel_id: '723456789012345678',
      war_id: 123,
      war_url: 'https://politicsandwar.com/nation/war/timeline/war=123',
      counter: { id: 77, url: 'https://nexus.example/counters/77' },
      attacker: {
        leader_name: 'Attacker',
        nation_name: 'Attacker Nation',
        score: 1000,
        cities: 20,
        alliance: { name: 'Attackers', acronym: 'ATK' },
        links: { nation: 'https://politicsandwar.com/nation/id=1' },
        military: { soldiers: 1000, tanks: 100, aircraft: 50, ships: 10 },
      },
      defender: {
        leader_name: 'Defender',
        nation_name: 'Defender Nation',
        score: 900,
        cities: 18,
        alliance: { name: 'Defenders' },
        military: { soldiers: 900, tanks: 90, aircraft: 45, ships: 9 },
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(sendAttempts, 2);
  const embed = sentPayload.embeds[0].toJSON();
  assert.equal(embed.title, '⚔️ War #123 Declared');
  assert.match(embed.description, /Attacker Nation.*declared war on.*Defender Nation/);
  assert.match(embed.description, /War timeline/);
  assert.deepEqual(embed.fields.map((field) => field.name), [
    'Attacker', 'Defender', 'Attacker military', 'Defender military',
  ]);
  assert.match(embed.fields[0].value, /1,000 score · 20 cities/);
  assert.equal(
    logger.entries.warn.some(([message]) => String(message).startsWith('Rate-limited while trying to send WAR_ALERT embed')),
    true,
  );
});
