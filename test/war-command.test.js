import test from 'node:test';
import assert from 'node:assert/strict';
import { data, execute } from '../src/commands/war.js';
import { embedJson } from './helpers.js';

const USER_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';

test('/war no longer registers legacy member assignment response controls', () => {
  const subcommands = data.toJSON().options.map((option) => option.name);
  assert.deepEqual(subcommands, ['active', 'counter', 'simulate']);
});

test('/war simulate uses readable plain-message continuation parts for long summaries', async () => {
  const replies = [];
  const followUps = [];
  const interaction = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: {
      getSubcommand: () => 'simulate',
      getString: () => 'war-token',
    },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
    followUp: async (payload) => { followUps.push(payload); },
  };
  const summary = Array.from({ length: 25 }, (_, index) => `Turn ${index + 1}: ${'simulation detail '.repeat(18)}`).join('\n\n');

  await execute(interaction, {
    apiService: { getWarSimulation: async () => ({ summary }) },
  });

  const messages = [...replies, ...followUps];
  assert.equal(replies.length, 1);
  assert.ok(followUps.length > 0);
  assert.ok(messages.every((message) => message.content.length <= 2_000));
  assert.ok(messages.every((message) => message.embeds.length === 0));
  assert.match(messages[0].content, /## ⚔️ War Simulation/);
  assert.match(messages.at(-1).content, /Verify the live war state before acting/);
  assert.ok(followUps.every((message) => message.ephemeral === true));
});
