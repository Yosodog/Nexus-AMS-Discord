import test from 'node:test';
import assert from 'node:assert/strict';
import { button as confirmApply, execute as executeApply } from '../src/commands/apply.js';
import { ApiContractError } from '../src/services/ApiService.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { createLogger, embedJson } from './helpers.js';

const GUILD_ID = '123456789012345678';
const USER_ID = '223456789012345678';
const INTENT_ID = 'a'.repeat(64);

const previewResponse = (overrides = {}) => ({
  intent: {
    id: INTENT_ID,
    action: 'application.create',
    expires_at: '2026-08-08T12:15:00Z',
  },
  summary: {
    description: 'Confirm to submit this nation for review and start private Discord setup.',
    nation: { id: 9001, name: 'Test Nation', leader_name: 'Test Leader' },
    continues_existing_application: false,
  },
  warnings: [],
  resource_version: 'resource-version',
  deep_link_path: null,
  ...overrides,
});

const confirmResponse = (overrides = {}) => ({
  application: {
    id: 42,
    nation_id: 9001,
    status: 'pending',
    continues_existing_application: false,
    created_at: '2026-08-08T12:00:00Z',
    updated_at: '2026-08-08T12:00:00Z',
  },
  channel_health: {
    state: 'preparing',
    label: 'Private interview channel setup is in progress.',
  },
  reconciliation: {
    state: 'queued',
    label: 'Discord follow-up is queued.',
  },
  progress: {
    facts: [],
    blockers: [],
    next_action: { label: 'Continue', deep_link_path: '/apply/42' },
  },
  deep_link_path: '/apply/42',
  ...overrides,
});

function createHarness() {
  const forbiddenGuildState = new Proxy({}, {
    get: (_target, property) => assert.fail(`/apply must not read or mutate Discord guild ${String(property)}`),
  });
  const interaction = {
    id: '323456789012345678',
    commandName: 'apply',
    nexusCommandName: 'apply',
    guildId: GUILD_ID,
    guild: {
      id: GUILD_ID,
      members: forbiddenGuildState,
      channels: forbiddenGuildState,
      roles: forbiddenGuildState,
    },
    user: {
      id: USER_ID,
      globalName: 'Applicant',
      tag: 'Applicant#0001',
      username: 'applicant',
    },
    options: { getInteger: () => 9001 },
    replies: [],
    edits: [],
    deferred: false,
    replied: false,
    deferReply: async (payload) => {
      interaction.deferred = true;
      interaction.deferPayload = payload;
    },
    reply: async (payload) => {
      interaction.replied = true;
      interaction.replies.push(payload);
    },
    editReply: async (payload) => interaction.edits.push(payload),
  };
  const sessions = new InteractionSessionStore({
    createToken: () => '11111111-2222-4333-8444-555555555555',
  });

  return { interaction, sessions };
}

function createButtonInteraction() {
  const interaction = {
    id: '423456789012345678',
    commandName: null,
    nexusCommandName: 'apply',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    edits: [],
    deferred: false,
    deferUpdate: async () => { interaction.deferred = true; },
    editReply: async (payload) => interaction.edits.push(payload),
    reply: async (payload) => interaction.edits.push(payload),
  };
  return interaction;
}

const confirmationCustomId = (message) => message.components[0].components[0].data.custom_id;

test('/apply previews then confirms through Nexus without touching Discord guild state', async () => {
  const { interaction, sessions } = createHarness();
  const calls = [];
  const apiService = {
    baseUrl: 'https://nexus.example',
    previewApplication: async (actor, payload) => {
      calls.push({ method: 'preview', actor, payload });
      return previewResponse();
    },
    confirmApplication: async (actor, payload) => {
      calls.push({ method: 'confirm', actor, payload });
      return confirmResponse();
    },
    createApplication: async () => assert.fail('legacy direct creation must not be used'),
    attachApplicationChannel: async () => assert.fail('the command must not attach channels'),
  };
  const context = { logger: createLogger(), apiService, sessions, guildId: GUILD_ID };

  await executeApply(interaction, context);

  assert.deepEqual(interaction.deferPayload, { ephemeral: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'preview');
  assert.deepEqual(calls[0].payload, {
    nation_id: 9001,
    discord_username: 'Applicant',
  });
  assert.equal(calls[0].actor.discordUserId, USER_ID);
  assert.equal(calls[0].actor.discordGuildId, GUILD_ID);
  assert.equal(calls[0].actor.discordInteractionId, interaction.id);
  assert.equal(embedJson(interaction.edits[0]).title, 'Review Application');
  assert.equal(interaction.edits[0].components.length, 1);

  const customId = confirmationCustomId(interaction.edits[0]);
  const session = sessions.resolve(customId, USER_ID);
  assert.equal(session.commandName, 'apply');
  assert.equal(session.event, 'confirm');
  assert.deepEqual(session.state, { intentId: INTENT_ID });

  const buttonInteraction = createButtonInteraction();
  await confirmApply(buttonInteraction, { ...context, session });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'confirm');
  assert.deepEqual(calls[1].payload, { intent_id: INTENT_ID });
  assert.equal(calls[1].actor.discordUserId, USER_ID);
  assert.equal(calls[1].actor.discordInteractionId, buttonInteraction.id);
  assert.equal(embedJson(buttonInteraction.edits[0]).title, 'Application Submitted');
  assert.match(embedJson(buttonInteraction.edits[0]).description, /preparing/i);
  assert.deepEqual(buttonInteraction.edits[0].components, []);
});

test('/apply clearly previews continuation of an existing application', async () => {
  const { interaction, sessions } = createHarness();
  const apiService = {
    baseUrl: 'https://nexus.example',
    previewApplication: async () => previewResponse({
      summary: {
        description: 'Nexus found your pending application.',
        nation: { id: 9001, name: 'Test Nation', leader_name: 'Test Leader' },
        continues_existing_application: true,
      },
      warnings: ['Nexus found your existing pending application and will continue it.'],
      deep_link_path: '/apply/42',
    }),
  };

  await executeApply(interaction, {
    logger: createLogger(), apiService, sessions, guildId: GUILD_ID,
  });

  assert.equal(embedJson(interaction.edits[0]).title, 'Review Application Continuation');
  assert.match(embedJson(interaction.edits[0]).fields.find((field) => field.name === 'Action').value, /Continue/);
  assert.equal(interaction.edits[0].components[0].components[0].data.label, 'Continue application');
});

test('/apply reports Nexus stale-preview guidance and performs no Discord mutation', async () => {
  const { interaction, sessions } = createHarness();
  const apiService = {
    baseUrl: 'https://nexus.example',
    previewApplication: async () => previewResponse(),
    confirmApplication: async () => {
      throw new ApiContractError('Your application eligibility changed after the preview.', {
        code: 'application_preview_stale',
        status: 409,
        details: { user_action: 'Run /apply again to review the latest application details.' },
      });
    },
  };
  const context = { logger: createLogger(), apiService, sessions, guildId: GUILD_ID };
  await executeApply(interaction, context);
  const session = sessions.resolve(confirmationCustomId(interaction.edits[0]), USER_ID);
  const buttonInteraction = createButtonInteraction();

  await confirmApply(buttonInteraction, { ...context, session });

  const embed = embedJson(buttonInteraction.edits[0]);
  assert.equal(embed.title, 'Application Submission Failed');
  assert.match(embed.description, /eligibility changed/i);
  assert.match(embed.footer.text, /Run \/apply again/i);
});

test('/apply fails closed when Nexus omits the opaque confirmation token', async () => {
  const { interaction, sessions } = createHarness();
  const apiService = {
    baseUrl: 'https://nexus.example',
    previewApplication: async () => previewResponse({ intent: { id: 'not-valid' } }),
    confirmApplication: async () => assert.fail('invalid previews cannot be confirmed'),
  };

  await executeApply(interaction, {
    logger: createLogger(), apiService, sessions, guildId: GUILD_ID,
  });

  assert.equal(embedJson(interaction.edits[0]).title, 'Application Preview Failed');
  assert.equal(interaction.edits[0].components.length, 0);
});

test('/apply rejects use outside its resolved guild before calling Nexus', async () => {
  const { interaction, sessions } = createHarness();
  interaction.guildId = '923456789012345678';
  const apiService = {
    previewApplication: async () => assert.fail('foreign guild must not call Nexus'),
  };

  await executeApply(interaction, {
    logger: createLogger(), apiService, sessions, guildId: GUILD_ID,
  });

  assert.equal(interaction.replies[0].ephemeral, true);
  assert.equal(embedJson(interaction.replies[0]).title, 'Application Unavailable');
});
