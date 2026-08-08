import test from 'node:test';
import assert from 'node:assert/strict';
import { autocomplete, button, execute } from '../src/commands/deposit.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { embedJson } from './helpers.js';

const GUILD_ID = '123456789012345678';
const USER_ID = '223456789012345678';
const ACCOUNT_ID = '7';

function sessions() {
  return new InteractionSessionStore({
    createToken: () => 'token000000000000000000000000001',
  });
}

function createInteraction({ id, accountId = ACCOUNT_ID, buttonId = null } = {}) {
  const interaction = {
    id: id ?? '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    commandName: buttonId ? undefined : 'deposit',
    customId: buttonId,
    options: {
      getString: () => accountId,
      getFocused: () => '',
    },
    deferred: false,
    replied: false,
    defers: [],
    edits: [],
    replies: [],
    deferReply: async (payload) => {
      interaction.deferred = true;
      interaction.defers.push(payload);
    },
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      interaction.edits.push(payload);
    },
    reply: async (payload) => {
      interaction.replied = true;
      interaction.replies.push(payload);
    },
    respond: async (choices) => {
      interaction.choices = choices;
    },
  };
  if (buttonId) interaction.nexusCommandName = 'deposit';
  return interaction;
}

function accountApi({ createDepositRequest = async () => ({}) } = {}) {
  const accountCalls = [];
  const createCalls = [];
  return {
    accountCalls,
    createCalls,
    apiService: {
      getMyAccounts: async (actor, params) => {
        accountCalls.push({ actor, params });
        return { accounts: [{ id: Number(ACCOUNT_ID), name: 'Operating Account', frozen: false }] };
      },
      createDepositRequest: async (...args) => {
        createCalls.push(args);
        return createDepositRequest(...args);
      },
    },
  };
}

async function prepareConfirmation({ createDepositRequest } = {}) {
  const sessionStore = sessions();
  const harness = accountApi({ createDepositRequest });
  const interaction = createInteraction();
  await execute(interaction, { apiService: harness.apiService, sessions: sessionStore });
  const buttonId = interaction.edits[0].components[0].toJSON().components[0].custom_id;
  const session = sessionStore.resolve(buttonId, USER_ID);
  return { ...harness, interaction, session, sessionStore, buttonId };
}

test('/deposit validates the selected Nexus account and does not mutate before confirmation', async () => {
  const { accountCalls, createCalls, interaction, session, buttonId } = await prepareConfirmation();

  assert.equal(createCalls.length, 0);
  assert.deepEqual(accountCalls[0].params, { account: ACCOUNT_ID, limit: 1 });
  assert.equal(accountCalls[0].actor.discordUserId, USER_ID);
  assert.equal(interaction.defers[0].ephemeral, true);
  assert.equal(embedJson(interaction.edits[0]).title, 'Review Deposit Request');
  assert.equal(session.event, 'confirm');
  assert.equal(session.state.accountId, ACCOUNT_ID);
  assert.equal(buttonId.startsWith('nxs:'), true);
});

test('/deposit creates the request only after confirmation', async () => {
  const result = {
    deposit_request: {
      account_id: Number(ACCOUNT_ID),
      deposit_code: 'NEXUS-123',
      status: 'pending',
      expires_at: '2026-08-08T13:00:00Z',
    },
    reused: false,
  };
  const prepared = await prepareConfirmation({ createDepositRequest: async () => result });
  const buttonInteraction = createInteraction({
    id: '423456789012345678',
    buttonId: prepared.buttonId,
  });

  await button(buttonInteraction, { apiService: prepared.apiService, session: prepared.session });

  assert.equal(prepared.createCalls.length, 1);
  assert.deepEqual(prepared.createCalls[0][1], ACCOUNT_ID);
  assert.deepEqual(prepared.createCalls[0][2], {});
  assert.equal(embedJson(buttonInteraction.edits[0]).title, 'Deposit Code Created');
  assert.match(embedJson(buttonInteraction.edits[0]).description, /NEXUS-123/);
});

test('/deposit renders a reused deposit result without creating a second code in Node', async () => {
  const prepared = await prepareConfirmation({
    createDepositRequest: async () => ({
      deposit_request: {
        account_id: Number(ACCOUNT_ID),
        deposit_code: 'NEXUS-EXISTING',
        status: 'pending',
      },
      reused: true,
    }),
  });
  const buttonInteraction = createInteraction({ buttonId: prepared.buttonId });

  await button(buttonInteraction, { apiService: prepared.apiService, session: prepared.session });

  assert.equal(prepared.createCalls.length, 1);
  assert.equal(embedJson(buttonInteraction.edits[0]).title, 'Existing Deposit Code');
  assert.match(embedJson(buttonInteraction.edits[0]).description, /NEXUS-EXISTING/);
});

test('/deposit renders API errors through the existing error helper', async () => {
  const error = Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' });
  const prepared = await prepareConfirmation({ createDepositRequest: async () => { throw error; } });
  const buttonInteraction = createInteraction({ buttonId: prepared.buttonId });

  await button(buttonInteraction, { apiService: prepared.apiService, session: prepared.session });

  const embed = embedJson(buttonInteraction.edits[0]);
  assert.equal(embed.title, 'Request Failed');
  assert.equal(embed.description, 'You do not have permission to do that.');
});

test('/deposit preserves Nexus-backed account autocomplete', async () => {
  const interaction = createInteraction();
  interaction.options.getFocused = () => 'oper';
  const { apiService, accountCalls } = accountApi();

  await autocomplete(interaction, { apiService });

  assert.equal(accountCalls.length, 1);
  assert.deepEqual(interaction.choices, [{ name: 'Operating Account', value: ACCOUNT_ID }]);
});
