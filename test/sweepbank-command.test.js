import test from 'node:test';
import assert from 'node:assert/strict';
import { execute as executeSweepbank } from '../src/commands/sweepbank.js';
import { createLogger, embedJson } from './helpers.js';

function createSweepInteraction({ inGuild = true, roles = ['guild-1'], note = null } = {}) {
  const interaction = {
    user: { id: 'moderator-1' },
    guildId: 'guild-1',
    channelId: 'channel-1',
    member: { roles },
    replies: [],
    edits: [],
    defers: [],
    inGuild: () => inGuild,
    options: {
      getString: () => note,
    },
    reply: async (payload) => {
      interaction.replies.push(payload);
    },
    deferReply: async (payload) => {
      interaction.defers.push(payload);
    },
    editReply: async (payload) => {
      interaction.edits.push(payload);
    },
  };

  return interaction;
}

test('/sweepbank denies users without a non-everyone role before calling Nexus', async () => {
  const interaction = createSweepInteraction({ roles: ['guild-1'] });
  const logger = createLogger();
  const apiService = {
    sweepPrimaryOffshore: async () => assert.fail('unauthorized user should not call Nexus'),
  };

  await executeSweepbank(interaction, { logger, apiService });

  assert.equal(interaction.replies[0].ephemeral, true);
  assert.equal(embedJson(interaction.replies[0]).title, 'Sweep Failed');
  assert.match(embedJson(interaction.replies[0]).description, /not allowed/i);
});

test('/sweepbank sends moderator id and trimmed note, then renders swept resources', async () => {
  const interaction = createSweepInteraction({ roles: ['guild-1', 'finance-role'], note: '  after audit  ' });
  const logger = createLogger();
  let apiPayload = null;
  const apiService = {
    sweepPrimaryOffshore: async (payload) => {
      apiPayload = payload;
      return {
        swept: true,
        offshore: { id: 7, name: 'Primary Vault' },
        transfer: {
          id: 99,
          payload: { money: 1234567, food: 50, uranium: 0 },
          message: 'Transfer queued.',
        },
      };
    },
  };

  await executeSweepbank(interaction, { logger, apiService });

  assert.deepEqual(apiPayload, { moderator_discord_id: 'moderator-1', note: 'after audit' });
  assert.equal(interaction.defers[0].ephemeral, true);

  const embed = embedJson(interaction.edits[0]);
  assert.equal(embed.title, 'Bank Swept');
  assert.match(embed.description, /Primary Vault/);
  assert.match(embed.fields[0].value, /Money: \$1,234,567/);
  assert.match(embed.fields[0].value, /Food: 50/);
  assert.doesNotMatch(embed.fields[0].value, /Uranium/);
});

test('/sweepbank maps Nexus moderator_not_found errors to a link-account response', async () => {
  const interaction = createSweepInteraction({ roles: ['guild-1', 'finance-role'] });
  const logger = createLogger();
  const apiService = {
    sweepPrimaryOffshore: async () => {
      const error = new Error('Forbidden');
      error.response = { status: 403, data: { error: 'moderator_not_found' } };
      throw error;
    },
  };

  await executeSweepbank(interaction, { logger, apiService });

  const embed = embedJson(interaction.edits[0]);
  assert.equal(embed.title, 'Sweep Failed');
  assert.equal(embed.description, 'Your Discord account is not linked to Nexus.');
});
