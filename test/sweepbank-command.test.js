import test from 'node:test';
import assert from 'node:assert/strict';
import { button, data, execute } from '../src/commands/sweepbank.js';
import { createLogger, embedJson } from './helpers.js';

const USER_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const CHANNEL_ID = '323456789012345678';
const INTERACTION_ID = '423456789012345678';
const INTENT_ID = 'a'.repeat(64);

const sessionsRecorder = () => {
  const created = [];
  return {
    created,
    create: (value) => {
      created.push(value);
      return `nxs:${created.length.toString().padStart(16, '0')}`;
    },
  };
};

function createSweepInteraction({ inGuild = true, roles = [GUILD_ID], note = null } = {}) {
  const interaction = {
    id: INTERACTION_ID,
    user: { id: USER_ID },
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    member: { roles },
    deferred: false,
    replied: false,
    replies: [],
    edits: [],
    defers: [],
    inGuild: () => inGuild,
    options: { getString: () => note },
    reply: async (payload) => {
      interaction.replied = true;
      interaction.replies.push(payload);
      return payload;
    },
    deferReply: async (payload) => {
      interaction.deferred = true;
      interaction.defers.push(payload);
    },
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      interaction.edits.push(payload);
      return payload;
    },
  };

  return interaction;
}

const preview = (overrides = {}) => ({
  sweep_required: true,
  intent: { id: INTENT_ID, expires_at: '2026-08-08T12:10:00Z' },
  summary: {
    description: 'Confirm the refreshed main-bank balances.',
    offshore: { id: 7, name: 'Primary Vault', alliance_id: 42 },
    resources: { money: 1234567, food: 50, uranium: 0 },
    note: 'after audit',
  },
  warnings: ['Balances will be refreshed before transfer.'],
  ...overrides,
});

test('/sweepbank delegates authorization to Nexus even without a local Discord role', async () => {
  const interaction = createSweepInteraction({ roles: [GUILD_ID] });
  const logger = createLogger();
  let called = false;
  const error = Object.assign(new Error('You do not have permission to manage offshores.'), {
    code: 'forbidden',
    status: 403,
  });
  const apiService = {
    previewPrimaryOffshoreSweep: async () => {
      called = true;
      throw error;
    },
  };

  await execute(interaction, { logger, apiService, sessions: sessionsRecorder() });

  assert.equal(called, true);
  assert.equal(interaction.defers[0].ephemeral, true);
  assert.match(embedJson(interaction.edits[0]).description, /permission/i);
});

test('/sweepbank previews only Nexus-owned fresh state and creates a one-shot confirmation', async () => {
  const interaction = createSweepInteraction({
    roles: [GUILD_ID, '523456789012345678'],
    note: '  after audit  ',
  });
  const logger = createLogger();
  const sessions = sessionsRecorder();
  const calls = [];
  const apiService = {
    baseUrl: 'https://nexus.example',
    previewPrimaryOffshoreSweep: async (actor, payload) => {
      calls.push({ actor, payload });
      return preview();
    },
  };

  await execute(interaction, { logger, apiService, sessions });

  assert.deepEqual(calls[0].payload, { note: 'after audit' });
  assert.equal(calls[0].actor.discordUserId, USER_ID);
  assert.equal(calls[0].actor.discordGuildId, GUILD_ID);
  assert.equal(calls[0].actor.discordInteractionId, INTERACTION_ID);
  assert.equal(calls[0].actor.discordAction, 'sweepbank');
  assert.doesNotMatch(JSON.stringify(calls[0].payload), /moderator|request_id|balance/i);
  assert.equal(interaction.defers[0].ephemeral, true);
  assert.equal(sessions.created.length, 1);
  assert.deepEqual(sessions.created[0], {
    commandName: 'sweepbank',
    userId: USER_ID,
    event: 'confirm',
    state: { intentId: INTENT_ID },
    oneShot: true,
  });

  const message = interaction.edits[0];
  const embed = embedJson(message);
  assert.equal(embed.title, 'Review Main Bank Sweep');
  assert.match(embed.fields.find(({ name }) => name === 'Resources').value, /Money: \$1,234,567/);
  assert.match(embed.fields.find(({ name }) => name === 'Resources').value, /Food: 50/);
  assert.doesNotMatch(embed.fields.find(({ name }) => name === 'Resources').value, /Uranium/);
  assert.equal(message.components[0].toJSON().components[0].label, 'Confirm bank sweep');
  assert.deepEqual(message.allowedMentions, { parse: [] });
});

test('/sweepbank renders an empty fresh preview without a confirmation control', async () => {
  const interaction = createSweepInteraction();
  const sessions = sessionsRecorder();
  await execute(interaction, {
    logger: createLogger(),
    sessions,
    apiService: {
      baseUrl: 'https://nexus.example',
      previewPrimaryOffshoreSweep: async () => preview({
        sweep_required: false,
        intent: null,
        summary: {
          offshore: { id: 7, name: 'Primary Vault', alliance_id: 42 },
          resources: {},
          note: 'unused',
        },
        warnings: [],
      }),
    },
  });

  assert.equal(sessions.created.length, 0);
  assert.equal(embedJson(interaction.edits[0]).title, 'No Sweep Needed');
  assert.equal(interaction.edits[0].components, undefined);
});

test('/sweepbank confirmation submits only the opaque Nexus intent and renders the transfer', async () => {
  const interaction = createSweepInteraction();
  let call = null;
  const apiService = {
    baseUrl: 'https://nexus.example',
    confirmPrimaryOffshoreSweep: async (actor, payload) => {
      call = { actor, payload };
      return {
        swept: true,
        reconciliation_required: false,
        offshore: { id: 7, name: 'Primary Vault', alliance_id: 42 },
        transfer: {
          id: 99,
          payload: { money: 1234567, food: 50, uranium: 0 },
          message: 'Transfer completed.',
          completed_at: '2026-08-08T12:05:00Z',
        },
      };
    },
  };

  await button(interaction, {
    apiService,
    logger: createLogger(),
    session: { event: 'confirm', state: { intentId: INTENT_ID } },
  });

  assert.deepEqual(call.payload, { intent_id: INTENT_ID });
  assert.deepEqual(Object.keys(call.payload), ['intent_id']);
  assert.equal(call.actor.discordUserId, USER_ID);
  assert.equal(embedJson(interaction.edits[0]).title, 'Bank Swept');
  assert.deepEqual(interaction.edits[0].components, []);
});

test('/sweepbank warns staff not to retry an ambiguous transfer', async () => {
  const interaction = createSweepInteraction();
  await button(interaction, {
    logger: createLogger(),
    apiService: {
      confirmPrimaryOffshoreSweep: async () => ({
        swept: false,
        reconciliation_required: true,
        transfer: { id: 99, status: 'reconciliation_required' },
      }),
    },
    session: { event: 'confirm', state: { intentId: INTENT_ID } },
  });

  assert.match(embedJson(interaction.edits[0]).description, /do not retry/i);
  assert.match(embedJson(interaction.edits[0]).description, /reconcile/i);
});

test('/sweepbank rejects stale component state before calling Nexus', async () => {
  const interaction = createSweepInteraction();
  let called = false;
  await button(interaction, {
    logger: createLogger(),
    apiService: {
      confirmPrimaryOffshoreSweep: async () => { called = true; },
    },
    session: { event: 'confirm', state: { intentId: 'invalid' } },
  });

  assert.equal(called, false);
  assert.equal(embedJson(interaction.edits[0]).title, 'Sweep Confirmation Failed');
});

test('/sweepbank note length matches the Nexus intent contract', () => {
  const command = data.toJSON();
  assert.equal(command.options.find(({ name }) => name === 'note').max_length, 255);
});
