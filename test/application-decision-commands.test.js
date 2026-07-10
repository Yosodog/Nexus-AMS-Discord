import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { execute as executeApprove } from '../src/commands/approve.js';
import { execute as executeDeny } from '../src/commands/deny.js';
import { buildApplicationChannelTopic } from '../src/utils/applicationChannels.js';
import { createLogger, embedJson } from './helpers.js';

const GUILD_ID = '123456789012345678';
const APPLICANT_ID = '223456789012345678';
const MODERATOR_ID = '323456789012345678';
const CHANNEL_ID = '423456789012345678';
const APPLICANT_ROLE_ID = '523456789012345678';
const MEMBER_ROLE_ID = '623456789012345678';
const ANNOUNCEMENT_CHANNEL_ID = '823456789012345678';

function createDecisionInteraction(channel, roleOperations) {
  const member = {
    roles: {
      remove: async (roleId) => roleOperations.push(['remove', roleId]),
      add: async (roleId) => roleOperations.push(['add', roleId]),
    },
  };
  const interaction = {
    id: '723456789012345678',
    guildId: GUILD_ID,
    guild: {
      id: GUILD_ID,
      members: { fetch: async () => member },
      channels: {
        cache: new Map(),
        fetch: async (id) => (id === CHANNEL_ID ? channel : null),
      },
    },
    client: { channels: { fetch: async () => null } },
    user: { id: MODERATOR_ID },
    options: {
      getUser: () => ({ id: APPLICANT_ID, toString: () => `<@${APPLICANT_ID}>` }),
    },
    replies: [],
    edits: [],
    deferReply: async () => {},
    reply: async (payload) => interaction.replies.push(payload),
    editReply: async (payload) => interaction.edits.push(payload),
  };
  return interaction;
}

function createInterviewChannel(overrides = {}) {
  return {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    type: ChannelType.GuildText,
    name: 'app-42-9001-test-leader',
    topic: buildApplicationChannelTopic(42, 9001),
    delete: async () => {},
    ...overrides,
  };
}

test('/approve removes/adds roles and deletes only the verified Nexus channel', async () => {
  const roleOperations = [];
  let deleted = false;
  const channel = createInterviewChannel({ delete: async () => { deleted = true; } });
  const interaction = createDecisionInteraction(channel, roleOperations);
  let announcement = null;
  interaction.client.channels.fetch = async (id) => ({
    id,
    guildId: GUILD_ID,
    isTextBased: () => true,
    send: async (payload) => { announcement = payload; },
  });
  const apiService = {
    approveApplication: async () => ({
      application: { id: 42, nation_id: 9001, discord_channel_id: CHANNEL_ID },
      config: {
        applicant_role_id: APPLICANT_ROLE_ID,
        member_role_id: MEMBER_ROLE_ID,
        approval_announcement_channel_id: ANNOUNCEMENT_CHANNEL_ID,
        approval_message_template: '@everyone Welcome aboard',
      },
    }),
  };

  await executeApprove(interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.equal(deleted, true);
  assert.deepEqual(roleOperations, [
    ['remove', APPLICANT_ROLE_ID],
    ['add', MEMBER_ROLE_ID],
  ]);
  assert.deepEqual(announcement.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(embedJson(interaction.edits[0]).title, 'Applicant Approved');
});

test('/approve reports cleanup pending and never deletes an unrelated cached channel', async () => {
  const roleOperations = [];
  let unrelatedDeleted = false;
  const unrelated = createInterviewChannel({ delete: async () => { unrelatedDeleted = true; } });
  const interaction = createDecisionInteraction(null, roleOperations);
  interaction.guild.channels.cache.set(CHANNEL_ID, unrelated);
  const apiService = {
    approveApplication: async () => ({
      application: { id: 42, nation_id: 9001, discord_channel_id: null },
      config: { applicant_role_id: APPLICANT_ROLE_ID, member_role_id: MEMBER_ROLE_ID },
    }),
  };

  await executeApprove(interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.equal(unrelatedDeleted, false);
  assert.match(embedJson(interaction.edits[0]).title, /Cleanup Pending/);
  assert.match(embedJson(interaction.edits[0]).description, /approved in Nexus/i);
});

test('/deny refuses a mismatched authoritative channel and reports partial success', async () => {
  const roleOperations = [];
  let deleted = false;
  const channel = createInterviewChannel({
    topic: buildApplicationChannelTopic(99, 9001),
    delete: async () => { deleted = true; },
  });
  const interaction = createDecisionInteraction(channel, roleOperations);
  const apiService = {
    denyApplication: async () => ({
      application: { id: 42, nation_id: 9001, discord_channel_id: CHANNEL_ID },
      config: { applicant_role_id: APPLICANT_ROLE_ID },
    }),
  };

  await executeDeny(interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.equal(deleted, false);
  assert.deepEqual(roleOperations, [['remove', APPLICANT_ROLE_ID]]);
  assert.match(embedJson(interaction.edits[0]).title, /Cleanup Pending/);
  assert.match(embedJson(interaction.edits[0]).description, /denied in Nexus/i);
});
