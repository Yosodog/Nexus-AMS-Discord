import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { execute as executeApply } from '../src/commands/apply.js';
import { buildApplicationChannelTopic } from '../src/utils/applicationChannels.js';
import { createLogger, embedJson } from './helpers.js';

const GUILD_ID = '123456789012345678';
const USER_ID = '223456789012345678';
const BOT_ID = '323456789012345678';
const CHANNEL_ID = '423456789012345678';
const APPLICANT_ROLE_ID = '523456789012345678';
const IA_ROLE_ID = '623456789012345678';
const CATEGORY_ID = '723456789012345678';

function createApplicationResponse() {
  return {
    application: { id: 42, nation_id: 9001, status: 'pending', discord_channel_id: null },
    nation: { id: 9001, nation_name: 'Test Nation', leader_name: 'Test Leader' },
    config: {
      applicant_role_id: APPLICANT_ROLE_ID,
      ia_role_id: IA_ROLE_ID,
      interview_category_id: CATEGORY_ID,
    },
  };
}

function createChannel(id = CHANNEL_ID) {
  const sends = [];
  return {
    id,
    guildId: GUILD_ID,
    type: ChannelType.GuildText,
    name: 'app-42-9001-test-leader',
    topic: buildApplicationChannelTopic(42, 9001),
    sends,
    send: async (payload) => sends.push(payload),
    toString: () => `<#${id}>`,
  };
}

function createApplyHarness({ channels = [], createChannelResult = createChannel() } = {}) {
  const roleAdds = [];
  const createdPayloads = [];
  const guild = {
    id: GUILD_ID,
    roles: { everyone: { id: GUILD_ID } },
    members: {
      fetch: async () => ({
        roles: {
          cache: new Map(),
          add: async (roleId) => roleAdds.push(roleId),
        },
      }),
    },
    channels: {
      fetch: async (id) => {
        if (id) {
          return channels.find((channel) => channel.id === id) ?? null;
        }
        return new Map(channels.map((channel) => [channel.id, channel]));
      },
      create: async (payload) => {
        createdPayloads.push(payload);
        return createChannelResult;
      },
    },
  };
  const interaction = {
    id: '823456789012345678',
    guildId: GUILD_ID,
    guild,
    user: { id: USER_ID, tag: 'Applicant#0001', toString: () => `<@${USER_ID}>` },
    client: { user: { id: BOT_ID } },
    options: { getInteger: () => 9001 },
    replies: [],
    edits: [],
    deferReply: async () => {},
    reply: async (payload) => interaction.replies.push(payload),
    editReply: async (payload) => interaction.edits.push(payload),
  };

  return { interaction, roleAdds, createdPayloads, createChannelResult };
}

test('/apply creates a metadata-marked channel, attaches it, and sends idempotent intros', async () => {
  const harness = createApplyHarness();
  const attached = [];
  const apiService = {
    createApplication: async () => createApplicationResponse(),
    attachApplicationChannel: async (payload) => attached.push(payload),
  };

  await executeApply(harness.interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.deepEqual(harness.roleAdds, [APPLICANT_ROLE_ID]);
  assert.equal(harness.createdPayloads.length, 1);
  assert.equal(harness.createdPayloads[0].topic, 'nexus-application:42;nation:9001');
  assert.deepEqual(attached, [{ application_id: 42, discord_channel_id: CHANNEL_ID }]);
  assert.equal(harness.createChannelResult.sends.length, 2);
  assert.equal(harness.createChannelResult.sends[0].enforceNonce, true);
  assert.equal(harness.createChannelResult.sends[1].enforceNonce, true);
  assert.deepEqual(harness.createChannelResult.sends[1].allowedMentions, {
    parse: [],
    users: [USER_ID],
    roles: [IA_ROLE_ID],
    repliedUser: false,
  });
  assert.equal(embedJson(harness.interaction.edits[0]).title, 'Application Submitted');
});

test('/apply reuses exactly one verified existing channel instead of creating a duplicate', async () => {
  const existing = createChannel();
  const harness = createApplyHarness({ channels: [existing] });
  const attached = [];
  const apiService = {
    createApplication: async () => createApplicationResponse(),
    attachApplicationChannel: async (payload) => attached.push(payload),
  };

  await executeApply(harness.interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.equal(harness.createdPayloads.length, 0);
  assert.deepEqual(attached, [{ application_id: 42, discord_channel_id: CHANNEL_ID }]);
  assert.equal(existing.sends.length, 2);
});

test('/apply resumes from an already attached verified channel without attaching again', async () => {
  const existing = createChannel();
  const harness = createApplyHarness({ channels: [existing] });
  const response = createApplicationResponse();
  response.application.discord_channel_id = CHANNEL_ID;
  const apiService = {
    createApplication: async () => response,
    attachApplicationChannel: async () => assert.fail('already attached channel must not be attached again'),
  };

  await executeApply(harness.interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.equal(harness.createdPayloads.length, 0);
  assert.equal(existing.sends.length, 2);
  assert.equal(embedJson(harness.interaction.edits[0]).title, 'Application Submitted');
});

test('/apply stops for manual resolution when multiple channels match exactly', async () => {
  const existingA = createChannel(CHANNEL_ID);
  const existingB = createChannel('923456789012345678');
  const harness = createApplyHarness({ channels: [existingA, existingB] });
  const apiService = {
    createApplication: async () => createApplicationResponse(),
    attachApplicationChannel: async () => assert.fail('ambiguous channel must not be attached'),
  };

  await executeApply(harness.interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.equal(harness.createdPayloads.length, 0);
  assert.equal(existingA.sends.length, 0);
  assert.equal(existingB.sends.length, 0);
  assert.match(embedJson(harness.interaction.edits[0]).title, /Setup Pending/);
});

test('/apply reports partial success when Nexus channel attachment fails', async () => {
  const harness = createApplyHarness();
  const apiService = {
    createApplication: async () => createApplicationResponse(),
    attachApplicationChannel: async () => { throw new Error('Nexus unavailable'); },
  };

  await executeApply(harness.interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.match(embedJson(harness.interaction.edits[0]).title, /Setup Pending/);
  assert.match(embedJson(harness.interaction.edits[0]).description, /submitted in Nexus/i);
  assert.equal(harness.createChannelResult.sends.length, 0);
});

test('/apply reports partial success when an intro send is interrupted', async () => {
  const existing = createChannel();
  existing.send = async () => { throw new Error('Discord unavailable'); };
  const harness = createApplyHarness({ channels: [existing] });
  const response = createApplicationResponse();
  response.application.discord_channel_id = CHANNEL_ID;
  const apiService = {
    createApplication: async () => response,
    attachApplicationChannel: async () => assert.fail('already attached channel must not be attached again'),
  };

  await executeApply(harness.interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.match(embedJson(harness.interaction.edits[0]).title, /Setup Pending/);
});
