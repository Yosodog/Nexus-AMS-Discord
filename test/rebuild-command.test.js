import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/commands/rebuild.js';

const USER_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const INTERACTION_ID = '323456789012345678';

test('rebuilding preview keeps account and note in local confirmation state', async () => {
  const previewCalls = [];
  const sessions = [];
  let reply;
  const interaction = {
    id: INTERACTION_ID,
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: {
      getSubcommand: () => 'apply',
      getString: (name) => ({ account: '42', note: 'Use the main account' })[name] ?? null,
    },
    deferReply: async () => {},
    editReply: async (payload) => { reply = payload; },
  };
  const context = {
    apiService: {
      previewRebuildRequest: async (...args) => {
        previewCalls.push(args);
        return {
          enabled: true,
          eligible: true,
          accounts: [{ id: 42, name: 'Main Account' }],
          estimated_amount: 5_000_000,
          city_count: 20,
          cycle_id: 3,
        };
      },
    },
    sessions: {
      create: (session) => {
        sessions.push(session);
        return `rebuild-${session.event}`;
      },
    },
  };

  await execute(interaction, context);

  assert.equal(previewCalls.length, 1);
  assert.equal(previewCalls[0].length, 1);
  const confirmation = sessions.find(({ event }) => event === 'confirm');
  assert.deepEqual(confirmation.state, {
    account_id: 42,
    note: 'Use the main account',
    accountName: 'Main Account',
    estimatedAmount: 5_000_000,
  });
  assert.equal(reply.components.length, 1);
});
