import test from 'node:test';
import assert from 'node:assert/strict';
import { execute as executeVerify } from '../src/commands/verify.js';
import { createLogger, embedJson } from './helpers.js';

function createVerifyInteraction(code) {
  const interaction = {
    user: {
      id: 'user-1',
      username: 'Tester',
      globalName: 'Test Global',
      discriminator: '0',
      displayAvatarURL: () => 'https://cdn.example/avatar.png',
    },
    guildId: 'guild-1',
    deferred: false,
    replied: false,
    replies: [],
    edits: [],
    followUps: [],
    defers: [],
    options: {
      getString: () => code,
    },
    reply: async (payload) => {
      interaction.replied = true;
      interaction.replies.push(payload);
    },
    deferReply: async (payload) => {
      interaction.deferred = true;
      interaction.defers.push(payload);
    },
    editReply: async (payload) => {
      interaction.edits.push(payload);
    },
    followUp: async (payload) => {
      interaction.followUps.push(payload);
    },
  };

  return interaction;
}

test('/verify rejects malformed codes before calling Nexus', async () => {
  const interaction = createVerifyInteraction('abc');
  const logger = createLogger();
  const apiService = {
    verifyUser: async () => assert.fail('invalid code should not call Nexus'),
  };

  await executeVerify(interaction, { logger, apiService });

  assert.equal(interaction.replied, true);
  assert.equal(interaction.defers.length, 0);
  assert.equal(embedJson(interaction.replies[0]).title, 'Verification Issue');
  assert.match(embedJson(interaction.replies[0]).description, /too short/i);
});

test('/verify sends normalized Discord identity and renders success', async () => {
  const interaction = createVerifyInteraction('  valid-code  ');
  const logger = createLogger();
  let apiPayload = null;
  const apiService = {
    verifyUser: async (payload) => {
      apiPayload = payload;
      return {
        success: true,
        data: {
          username: 'NexusUser',
          message: 'Linked successfully.',
        },
      };
    },
  };

  await executeVerify(interaction, { logger, apiService });

  assert.equal(interaction.defers[0].ephemeral, true);
  assert.equal(apiPayload.token, 'valid-code');
  assert.equal(apiPayload.discord_id, 'user-1');
  assert.equal(apiPayload.discord_username, 'Tester');
  assert.equal(apiPayload.discord_global_name, 'Test Global');
  assert.equal(apiPayload.discord_avatar, 'https://cdn.example/avatar.png');

  const embed = embedJson(interaction.edits[0]);
  assert.equal(embed.title, 'Verification Successful');
  assert.equal(embed.description, 'Linked successfully.');
  assert.equal(embed.fields[0].value, '`NexusUser`');
});

test('/verify renders friendly API failure messages', async () => {
  const interaction = createVerifyInteraction('valid-code');
  const logger = createLogger();
  const apiService = {
    verifyUser: async () => ({
      success: false,
      message: 'This verification request was already used.',
    }),
  };

  await executeVerify(interaction, { logger, apiService });

  const embed = embedJson(interaction.edits[0]);
  assert.equal(embed.title, 'Verification Failed');
  assert.equal(embed.description, 'This verification request was already used.');
});
