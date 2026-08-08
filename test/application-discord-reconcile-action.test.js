import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  execute,
  validate,
} from '../src/services/queueActions/applicationDiscordReconcile.js';
import { buildApplicationChannelTopic } from '../src/utils/applicationChannels.js';

const APP_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const OTHER_GUILD_ID = '323456789012345678';
const USER_ID = '423456789012345678';
const STAFF_ROLE_ID = '523456789012345678';
const ADD_ROLE_ID = '623456789012345678';
const REMOVE_ROLE_ID = '723456789012345678';
const PRESERVED_ROLE_ID = '823456789012345678';
const CHANNEL_ID = '923456789012345678';
const OTHER_CHANNEL_ID = '923456789012345679';
const CONNECTION_ID = '123e4567-e89b-12d3-a456-426614174000';
const TOPIC = buildApplicationChannelTopic(42, 9001);

function payload(overrides = {}) {
  const base = {
    contract_version: 1,
    installation: {
      application_id: APP_ID,
      guild_id: GUILD_ID,
      connection_id: CONNECTION_ID,
      generation: 7,
    },
    application: {
      id: 42,
      state: 'pending',
      discord_user_id: USER_ID,
      nation_id: 9001,
      revision: 12,
    },
    desired: {
      channel: {
        mode: 'ensure',
        name: 'application-42-9001',
        topic: TOPIC,
        staff_role_ids: [STAFF_ROLE_ID],
        intro_messages: [{ key: 'welcome', content: 'Welcome to the interview.' }],
      },
      roles: { add: [], remove: [] },
      notifications: [],
    },
  };
  return {
    ...base,
    ...overrides,
    installation: { ...base.installation, ...overrides.installation },
    application: { ...base.application, ...overrides.application },
    desired: {
      ...base.desired,
      ...overrides.desired,
      channel: { ...base.desired.channel, ...overrides.desired?.channel },
      roles: { ...base.desired.roles, ...overrides.desired?.roles },
      notifications: overrides.desired?.notifications ?? base.desired.notifications,
    },
  };
}

function makeChannel(id, overrides = {}) {
  const sent = [];
  const channel = {
    id,
    guildId: GUILD_ID,
    type: ChannelType.GuildText,
    name: 'application-42-9001',
    topic: TOPIC,
    sent,
    isTextBased: () => true,
    send: async (message) => {
      sent.push(message);
      return { id: `${id}1` };
    },
    delete: async () => {},
    ...overrides,
  };
  return channel;
}

function makeRole(id, overrides = {}) {
  return { id, managed: false, editable: true, manageable: true, ...overrides };
}

function makeRuntime({
  channels = [],
  channelList = null,
  channelListFailure = false,
  roles = [],
  memberRoles = [],
  member = null,
  connectionContext,
  checkpoint,
  events = [],
  user = { id: USER_ID, send: async () => ({ id: 'dm-message' }) },
  resolveUser = null,
} = {}) {
  const channelCache = new Map(channels.map((channel) => [channel.id, channel]));
  const roleCache = new Map([
    [GUILD_ID, makeRole(GUILD_ID, { managed: false, editable: false, manageable: false })],
    [STAFF_ROLE_ID, makeRole(STAFF_ROLE_ID)],
    [ADD_ROLE_ID, makeRole(ADD_ROLE_ID)],
    [REMOVE_ROLE_ID, makeRole(REMOVE_ROLE_ID)],
    [PRESERVED_ROLE_ID, makeRole(PRESERVED_ROLE_ID)],
    ...roles.map((role) => [role.id, role]),
  ]);
  const actualMember = member ?? {
    id: USER_ID,
    guildId: GUILD_ID,
    manageable: true,
    roles: {
      cache: new Map(memberRoles.map((roleId) => [roleId, makeRole(roleId)])),
      add: async (roleId) => {
        events.push(['role_add', roleId]);
        actualMember.roles.cache.set(roleId, roleCache.get(roleId) ?? makeRole(roleId));
      },
      remove: async (roleId) => {
        events.push(['role_remove', roleId]);
        actualMember.roles.cache.delete(roleId);
      },
    },
  };
  const guild = {
    id: GUILD_ID,
    roles: {
      everyone: { id: GUILD_ID },
      cache: roleCache,
      fetch: async (roleId) => roleCache.get(roleId) ?? null,
    },
    members: {
      fetch: async (userId) => (userId === USER_ID ? actualMember : null),
    },
    channels: {
      cache: channelCache,
      fetch: async (channelId) => {
        if (channelId === undefined) {
          if (channelListFailure) {
            const error = new Error('Guild channel listing failed');
            error.code = 503;
            throw error;
          }
          if (channelList instanceof Map) return channelList;
          return new Map((channelList ?? Array.from(channelCache.values())).map((channel) => [channel.id, channel]));
        }
        if (channelCache.has(channelId)) return channelCache.get(channelId);
        const error = new Error('Unknown Channel');
        error.code = 10003;
        throw error;
      },
      create: async (options) => {
        events.push(['channel_create', options]);
        const created = makeChannel(CHANNEL_ID, {
          name: options.name,
          topic: options.topic,
          type: options.type,
          permissionOverwrites: options.permissionOverwrites,
          parent: options.parent,
        });
        channelCache.set(created.id, created);
        return created;
      },
    },
  };
  const checkpoints = [];
  const runtime = {
    guildId: GUILD_ID,
    ...(connectionContext ? { connectionContext } : {}),
    logger: { info() {}, warn() {}, error() {} },
    resolveGuild: async () => guild,
    resolveUser: resolveUser ?? (async () => user),
    withDiscordRetry: async (operation) => operation(),
    send: async (channel, command, stepKey, message) => {
      events.push(['send', stepKey, message]);
      return channel.send(message);
    },
    sendDirectMessage: async (target, command, stepKey, message) => {
      events.push(['dm', stepKey, message]);
      return target.send(message);
    },
    apiService: {
      checkpointDiscordQueue: async (...args) => {
        events.push(['checkpoint', ...args]);
        checkpoints.push(args);
        if (checkpoint) return checkpoint(...args);
        return { ok: true };
      },
    },
  };
  return { runtime, guild, actualMember, checkpoints, events };
}

function commandFor(input, result = {}) {
  return {
    id: 'queue-application-1',
    lease_token: 'lease-application-1',
    guild_id: GUILD_ID,
    payload: input,
    result,
  };
}

test('validates the closed v1 payload and rejects unknown, unsafe, and assignment fields', () => {
  assert.equal(validate(payload()).valid, true);

  const unknownTopLevel = payload({ extra: true });
  assert.equal(validate(unknownTopLevel).valid, false);

  const unknownNested = payload({
    desired: { channel: { extra: true } },
  });
  assert.equal(validate(unknownNested).valid, false);
  assert.equal(validate(payload({ application: { state: 'obsolete' } })).valid, false);
  assert.equal(validate(payload({ application: { revision: 0 } })).valid, false);

  const mention = payload({
    desired: { notifications: [{
      key: 'notice',
      destination: { type: 'dm', discord_user_id: USER_ID },
      content: 'Hello <@&523456789012345678>',
    }] },
  });
  assert.equal(validate(mention).valid, false);

  const assignment = payload({
    desired: { notifications: [{
      key: 'war.assignment',
      destination: { type: 'dm', discord_user_id: USER_ID },
      content: 'You have a war assignment.',
    }] },
  });
  assert.equal(validate(assignment).valid, false);
});

test('fails closed for foreign guilds and exposed application connection context', async () => {
  const { runtime } = makeRuntime({
    connectionContext: {
      application_id: APP_ID,
      connection_id: CONNECTION_ID,
      generation: 7,
    },
  });
  const input = payload({ desired: { channel: { mode: 'unchanged', intro_messages: [] } } });

  assert.equal((await execute(commandFor(input, {}), runtime)).reason, undefined);

  const foreignCommand = { ...commandFor(input), guild_id: OTHER_GUILD_ID };
  assert.equal((await execute(foreignCommand, runtime)).reason, 'wrong_guild');

  const wrongApplication = makeRuntime({
    connectionContext: { application_id: OTHER_GUILD_ID, connection_id: CONNECTION_ID, generation: 7 },
  });
  assert.equal((await execute(commandFor(input), wrongApplication.runtime)).reason, 'wrong_application');

  const wrongConnection = makeRuntime({
    connectionContext: { application_id: APP_ID, connection_id: '123e4567-e89b-12d3-a456-426614174001', generation: 7 },
  });
  assert.equal((await execute(commandFor(input), wrongConnection.runtime)).reason, 'wrong_connection');

  const staleGeneration = makeRuntime({
    connectionContext: { application_id: APP_ID, connection_id: CONNECTION_ID, generation: 8 },
  });
  assert.equal((await execute(commandFor(input), staleGeneration.runtime)).reason, 'stale_connection_generation');
});

test('creates a channel, checkpoints it before intros, and disables all mentions', async () => {
  const { runtime, events, checkpoints } = makeRuntime();
  const result = await execute(commandFor(payload()), runtime);

  assert.equal(result.success, true);
  assert.equal(checkpoints[0][2].application_reconcile.channel_id, CHANNEL_ID);
  assert.equal(result.result.application_reconcile.application_revision, 12);
  const createIndex = events.findIndex(([type]) => type === 'channel_create');
  const firstCheckpointIndex = events.findIndex(([type]) => type === 'checkpoint');
  const sendIndex = events.findIndex(([type]) => type === 'send');
  assert.ok(createIndex < firstCheckpointIndex);
  assert.ok(firstCheckpointIndex < sendIndex);
  assert.deepEqual(events[sendIndex][2].allowedMentions, {
    parse: [],
    users: [],
    roles: [],
    repliedUser: false,
  });

  const options = events[createIndex][1];
  assert.deepEqual(options.permissionOverwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
  assert.ok(options.permissionOverwrites.some((overwrite) => overwrite.id === USER_ID));
  assert.ok(options.permissionOverwrites.some((overwrite) => overwrite.id === STAFF_ROLE_ID));
  const botOverwrite = options.permissionOverwrites.find((overwrite) => overwrite.id === APP_ID);
  assert.ok(botOverwrite);
  assert.deepEqual(botOverwrite.allow, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
});

test('restarts from the durable checkpoint without recreating or resending', async () => {
  const first = makeRuntime();
  const firstResult = await execute(commandFor(payload()), first.runtime);
  const durable = firstResult.result.application_reconcile;
  const existing = first.guild.channels.cache.get(CHANNEL_ID);
  const second = makeRuntime({ channels: [existing] });

  const result = await execute(commandFor(payload(), { application_reconcile: durable }), second.runtime);

  assert.equal(result.success, true);
  assert.equal(second.events.some(([type]) => type === 'channel_create'), false);
  assert.equal(second.events.some(([type]) => type === 'send'), false);
});

test('reuses one exact-topic channel and rejects duplicate exact-topic channels', async () => {
  const existing = makeChannel(CHANNEL_ID);
  const reused = makeRuntime({ channels: [existing] });
  const input = payload({ desired: { channel: { intro_messages: [] } } });
  const reusedResult = await execute(commandFor(input), reused.runtime);
  assert.equal(reusedResult.success, true);
  assert.equal(reused.events.some(([type]) => type === 'channel_create'), false);

  const duplicate = makeRuntime({ channels: [existing, makeChannel(OTHER_CHANNEL_ID)] });
  const duplicateResult = await execute(commandFor(input), duplicate.runtime);
  assert.equal(duplicateResult.reason, 'duplicate_channel_topic');
});

test('recovers one verified interview channel from a cold full-channel listing', async () => {
  const existing = makeChannel(CHANNEL_ID);
  const runtimeData = makeRuntime({ channelList: [existing] });
  const input = payload({ desired: { channel: { intro_messages: [] } } });
  delete input.desired.channel.topic;

  const result = await execute(commandFor(input), runtimeData.runtime);

  assert.equal(result.success, true);
  assert.equal(runtimeData.events.some(([type]) => type === 'channel_create'), false);
});

test('fails closed on cold-cache duplicate topics and full-channel listing failure', async () => {
  const duplicateInput = payload({ desired: { channel: { intro_messages: [] } } });
  delete duplicateInput.desired.channel.topic;
  const duplicate = makeRuntime({
    channelList: [makeChannel(CHANNEL_ID), makeChannel(OTHER_CHANNEL_ID)],
  });
  const duplicateResult = await execute(commandFor(duplicateInput), duplicate.runtime);
  assert.equal(duplicateResult.reason, 'duplicate_channel_topic');
  assert.equal(duplicate.events.some(([type]) => type === 'channel_create'), false);

  const listingFailure = makeRuntime({ channelListFailure: true });
  const listingResult = await execute(commandFor(duplicateInput), listingFailure.runtime);
  assert.equal(listingResult.reason, 'channel_collection_unavailable');
  assert.equal(listingFailure.events.some(([type]) => type === 'channel_create'), false);
});

test('recovers and deletes exactly one absent channel by its derived topic', async () => {
  let deleted = false;
  const recovered = makeChannel(CHANNEL_ID, { delete: async () => { deleted = true; } });
  const runtimeData = makeRuntime({ channelList: [recovered] });
  const input = payload({
    desired: { channel: { mode: 'absent', intro_messages: [] } },
  });
  delete input.desired.channel.topic;

  const result = await execute(commandFor(input), runtimeData.runtime);

  assert.equal(result.success, true);
  assert.equal(deleted, true);
  assert.equal(result.result.application_reconcile.channel_deleted, true);
});

test('rejects a channel whose guild metadata is missing', async () => {
  const missingGuild = makeChannel(CHANNEL_ID, { guildId: undefined });
  const runtimeData = makeRuntime({ channels: [missingGuild] });
  const input = payload({
    desired: { channel: { channel_id: CHANNEL_ID, intro_messages: [] } },
  });

  const result = await execute(commandFor(input), runtimeData.runtime);

  assert.equal(result.reason, 'wrong_guild_channel');
});

test('rejects unknown and legacy-shaped durable checkpoints', async () => {
  const input = payload({ desired: { channel: { mode: 'unchanged', intro_messages: [] } } });
  const checkpoints = [
    { unexpected: true },
    { discord_channel_id: CHANNEL_ID },
    { intro_message_keys: [] },
    { notification_keys: [] },
  ];

  for (const applicationReconcile of checkpoints) {
    const runtimeData = makeRuntime();
    const result = await execute(
      commandFor(input, { application_reconcile: applicationReconcile }),
      runtimeData.runtime,
    );
    assert.equal(result.reason, 'invalid_checkpoint');
  }

  const stale = await execute(
    commandFor(input, { application_reconcile: { application_revision: 11 } }),
    makeRuntime().runtime,
  );
  assert.equal(stale.reason, 'checkpoint_revision_mismatch');
});

test('changes only Nexus-supplied roles, preserves unrelated roles, and rejects hierarchy failures', async () => {
  const roleOperations = [];
  const runtimeData = makeRuntime({ memberRoles: [REMOVE_ROLE_ID, PRESERVED_ROLE_ID] });
  runtimeData.actualMember.roles.add = async (roleId) => {
    roleOperations.push(['add', roleId]);
    runtimeData.actualMember.roles.cache.set(roleId, makeRole(roleId));
  };
  runtimeData.actualMember.roles.remove = async (roleId) => {
    roleOperations.push(['remove', roleId]);
    runtimeData.actualMember.roles.cache.delete(roleId);
  };
  const input = payload({
    desired: {
      channel: { mode: 'unchanged', intro_messages: [] },
      roles: { add: [ADD_ROLE_ID], remove: [REMOVE_ROLE_ID] },
    },
  });
  const result = await execute(commandFor(input), runtimeData.runtime);
  assert.equal(result.success, true);
  assert.deepEqual(roleOperations, [['add', ADD_ROLE_ID], ['remove', REMOVE_ROLE_ID]]);
  assert.equal(runtimeData.actualMember.roles.cache.has(PRESERVED_ROLE_ID), true);

  const hierarchy = makeRuntime({ roles: [makeRole(ADD_ROLE_ID, { editable: false })] });
  const hierarchyResult = await execute(commandFor(input), hierarchy.runtime);
  assert.equal(hierarchyResult.reason, 'role_unmanageable');
});

test('deletes only the authoritative channel and treats an unknown channel as idempotent', async () => {
  let deletedAuthoritative = false;
  const authoritative = makeChannel(CHANNEL_ID, {
    delete: async () => { deletedAuthoritative = true; },
  });
  const unrelated = makeChannel(OTHER_CHANNEL_ID, {
    topic: 'nexus-application:42;nation:9001',
    delete: async () => { throw new Error('unrelated channel deleted'); },
  });
  const input = payload({
    desired: {
      channel: { mode: 'absent', channel_id: CHANNEL_ID, topic: TOPIC, intro_messages: [] },
    },
  });
  const runtimeData = makeRuntime({ channels: [authoritative, unrelated] });
  const result = await execute(commandFor(input), runtimeData.runtime);
  assert.equal(result.success, true);
  assert.equal(deletedAuthoritative, true);
  assert.equal(runtimeData.guild.channels.cache.has(OTHER_CHANNEL_ID), true);
  assert.equal(result.result.application_reconcile.channel_deleted, true);

  const missing = makeRuntime();
  const missingInput = payload({
    desired: { channel: { mode: 'absent', channel_id: CHANNEL_ID, topic: TOPIC, intro_messages: [] } },
  });
  const missingResult = await execute(commandFor(missingInput), missing.runtime);
  assert.equal(missingResult.success, true);
  assert.equal(missingResult.result.application_reconcile.channel_deleted, true);
});

test('requires reconciliation when a mutation succeeds but its checkpoint fails', async () => {
  const created = makeRuntime({
    checkpoint: async () => { throw new Error('checkpoint unavailable'); },
  });
  const result = await execute(commandFor(payload()), created.runtime);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'checkpoint_failed');
  assert.equal(result.reconciliation_required, true);
  assert.equal(result.result.application_reconcile.channel_id, CHANNEL_ID);
  assert.equal(created.events.some(([type]) => type === 'send'), false);
});

test('never falls back to a public channel when a DM is closed', async () => {
  const publicChannel = makeChannel(CHANNEL_ID);
  const closedDm = {
    id: USER_ID,
    send: async () => {
      const error = new Error('Cannot send messages to this user');
      error.code = 50007;
      throw error;
    },
  };
  const runtimeData = makeRuntime({
    channels: [publicChannel],
    user: closedDm,
  });
  const input = payload({
    desired: {
      channel: { mode: 'unchanged', intro_messages: [] },
      notifications: [{
        key: 'application.status',
        destination: { type: 'dm', discord_user_id: USER_ID },
        content: 'Your application is pending.',
      }],
    },
  });
  const result = await execute(commandFor(input), runtimeData.runtime);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'dm_closed');
  assert.equal(runtimeData.events.some(([type]) => type === 'send'), false);
});

test('does not accept proactive assignment alert content', () => {
  const input = payload({
    desired: {
      notifications: [{
        key: 'application.status',
        destination: { type: 'channel', channel_id: CHANNEL_ID },
        content: 'A target has been assigned to you.',
      }],
    },
  });
  assert.deepEqual(validate(input), { valid: false, reason: 'invalid_notification' });
});
