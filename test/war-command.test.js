import test from 'node:test';
import assert from 'node:assert/strict';
import { autocomplete, data, execute } from '../src/commands/war.js';
import { embedJson } from './helpers.js';

const USER_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';

test('/war no longer registers legacy member assignment response controls', () => {
  const subcommands = data.toJSON().options.map((option) => option.name);
  assert.deepEqual(subcommands, ['active', 'counter', 'simulate']);
});

test('/war autocomplete filters active wars locally without provider query parameters', async () => {
  const calls = [];
  const wars = [
    { id: 11, token: 'war-alpha', label: 'Alpha Front' },
    { id: 12, token: 'war-beta', name: 'Beta Clash' },
    { id: 13, token: 'war-gamma', summary: 'Gamma pressure' },
  ];
  const apiService = {
    getMyActiveWars: async (...args) => {
      calls.push(args);
      return wars;
    },
  };
  const cases = [
    ['alpha front', 'war-alpha'],
    ['beta clash', 'war-beta'],
    ['gamma pressure', 'war-gamma'],
    ['war-alpha', 'war-alpha'],
    ['13', 'war-gamma'],
  ];

  for (const [query, expectedToken] of cases) {
    const responses = [];
    const interaction = {
      id: '323456789012345678',
      guildId: GUILD_ID,
      user: { id: USER_ID },
      options: { getFocused: () => query },
      respond: async (choices) => { responses.push(choices); },
    };
    await autocomplete(interaction, { apiService });
    assert.deepEqual(responses[0].map(({ value }) => value), [expectedToken]);
  }

  assert.equal(calls.length, cases.length);
  assert.equal(calls.every((args) => args.length === 1), true);
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
