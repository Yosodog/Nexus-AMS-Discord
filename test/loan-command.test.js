import test from 'node:test';
import assert from 'node:assert/strict';
import { autocomplete, execute } from '../src/commands/loan.js';
import { embedJson } from './helpers.js';

const USER_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const INTERACTION_ID = '323456789012345678';

const loans = [
  { id: 101, token: 'loan-alpha', label: 'Growth Fund', reference: 'REF-ONE', status: 'active' },
  { id: 202, token: 'loan-beta', name: 'Emergency Loan', reference: 'REF-TWO', status: 'active' },
];

const autocompleteInteraction = (query) => {
  const responses = [];
  return {
    id: INTERACTION_ID,
    guildId: GUILD_ID,
    user: { id: USER_ID },
    responses,
    options: {
      getFocused: (withName = false) => (withName ? { name: 'loan', value: query } : query),
    },
    respond: async (choices) => { responses.push(choices); },
  };
};

test('loan autocomplete filters the unfiltered provider collection locally', async () => {
  const calls = [];
  const apiService = {
    getMyLoans: async (...args) => {
      calls.push(args);
      return loans;
    },
  };
  const cases = [
    ['growth', 'loan-alpha'],
    ['ref-two', 'loan-beta'],
    ['loan-alpha', 'loan-alpha'],
    ['202', 'loan-beta'],
  ];

  for (const [query, expectedToken] of cases) {
    const interaction = autocompleteInteraction(query);
    await autocomplete(interaction, { apiService });
    assert.deepEqual(interaction.responses[0].map(({ value }) => value), [expectedToken]);
  }

  assert.equal(calls.length, cases.length);
  assert.equal(calls.every((args) => args.length === 1), true);
});

test('loan status selects one loan locally without sending a provider filter', async () => {
  const calls = [];
  let reply;
  const interaction = {
    id: INTERACTION_ID,
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: {
      getSubcommand: () => 'status',
      getString: (name) => (name === 'loan' ? 'loan-beta' : null),
    },
    deferReply: async () => {},
    editReply: async (payload) => { reply = payload; },
  };
  const apiService = {
    baseUrl: 'https://nexus.example',
    getMyLoans: async (...args) => {
      calls.push(args);
      return loans;
    },
  };

  await execute(interaction, { apiService });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.deepEqual(embedJson(reply).fields.map(({ name }) => name), ['Loan #202']);
});
