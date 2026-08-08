import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { data, autocomplete, button, execute } from '../src/commands/audit.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { registerInteractionListener } from '../src/listeners/interactionCreate.js';
import { createEventClient, createLogger, embedJson } from './helpers.js';

const actor = { id: '234567890123456789' };

const finding = (overrides = {}) => ({
  id: 7,
  name: 'Warchest below requirement',
  description: 'The nation does not meet the configured warchest requirement.',
  plain_language_summary: 'Your warchest is below the alliance minimum.',
  remediation_guidance: 'Deposit enough resources to meet the warchest requirement.',
  priority: 'high',
  target: 'Nation-wide',
  target_type: 'nation',
  due_at: '2026-08-15T12:00:00Z',
  first_detected_at: '2026-08-01T12:00:00Z',
  last_evaluated_at: '2026-08-08T12:00:00Z',
  evidence: [{
    field_label: 'Warchest value',
    observed_display: '$10,000',
    expected_display: '$25,000',
    matched: false,
  }],
  ...overrides,
});

const makeInteraction = (subcommand, values = {}, user = actor) => {
  const replies = [];
  const interaction = {
    user,
    guildId: '123456789012345678',
    id: '345678901234567890',
    commandName: 'audit',
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => subcommand,
      getInteger: (name) => values[name] ?? null,
      getString: (name) => values[name] ?? null,
      getFocused: () => values.focused ?? '',
    },
    deferReply: async ({ ephemeral }) => {
      assert.equal(ephemeral, true);
      interaction.deferred = true;
    },
    editReply: async (payload) => { replies.push(payload); return payload; },
    update: async (payload) => { replies.push(payload); interaction.replied = true; return payload; },
    deferUpdate: async () => { interaction.deferred = true; },
    replies,
  };
  return interaction;
};

const makeButtonInteraction = (customId, user = actor) => {
  const replies = [];
  const interaction = {
    customId,
    user,
    guildId: '123456789012345678',
    id: '456789012345678901',
    commandName: 'audit',
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isModalSubmit: () => false,
    deferUpdate: async () => { interaction.deferred = true; },
    reply: async (payload) => { replies.push(payload); interaction.replied = true; return payload; },
    update: async (payload) => { replies.push(payload); interaction.replied = true; return payload; },
    editReply: async (payload) => { replies.push(payload); return payload; },
    replies,
  };
  return interaction;
};

const sessionStore = () => {
  let sequence = 0;
  return new InteractionSessionStore({
    createToken: () => `audit${String(sequence += 1).padStart(28, '0')}`,
  });
};

test('audit command is guild-only and exposes explain plus remediation subcommands', () => {
  const command = data.toJSON();
  assert.equal(command.name, 'audit');
  assert.equal(command.dm_permission, false);
  assert.deepEqual(command.options.map((option) => option.name), [
    'status', 'explain', 'acknowledge', 'snooze',
  ]);
  assert.equal(command.options[1].options[0].autocomplete, true);
});

test('audit status renders Nexus summary, remediation, evidence, due date, and freshness', async () => {
  const interaction = makeInteraction('status');
  let receivedActor;
  await execute(interaction, {
    apiService: {
      baseUrl: 'https://nexus.example',
      getMyAuditFindings: async (value) => {
        receivedActor = value;
        return [finding()];
      },
    },
    sessions: sessionStore(),
  });

  assert.equal(receivedActor.discordUserId, actor.id);
  assert.equal(interaction.replies.length, 1);
  const embed = embedJson(interaction.replies[0]);
  assert.equal(embed.title, 'Your Audit Findings');
  assert.match(embed.description, /Open the audit center in Nexus/);
  assert.match(embed.fields[0].name, /Warchest below requirement/);
  assert.match(embed.fields[0].value, /Your warchest is below the alliance minimum/);
  assert.match(embed.fields[0].value, /How to correct/);
  assert.match(embed.fields[0].value, /Deposit enough resources/);
  assert.match(embed.fields[0].value, /Evidence/);
  assert.match(embed.fields[0].value, /Warchest value/);
  assert.match(embed.fields[0].value, /Due/);
  assert.match(embed.fields[0].value, /Freshness/);
});

test('audit explain renders the selected actor-scoped finding in detail', async () => {
  const interaction = makeInteraction('explain', { finding: '7' });
  await execute(interaction, {
    apiService: {
      baseUrl: 'https://nexus.example',
      getMyAuditFindings: async () => [finding()],
    },
    sessions: sessionStore(),
  });

  const embed = embedJson(interaction.replies[0]);
  assert.match(embed.title, /Warchest below requirement/);
  assert.match(embed.description, /Your warchest is below the alliance minimum/);
  assert.match(embed.fields.find((field) => field.name === 'How to correct').value,
    /Deposit enough resources to meet the warchest requirement/);
  assert.match(embed.fields.find((field) => field.name === 'Evidence').value, /Observed/);
  assert.ok(embed.fields.some((field) => field.name === 'Due'));
  assert.ok(embed.fields.some((field) => field.name === 'Freshness'));
});

test('audit explain autocomplete filters only the current actor-scoped result set', async () => {
  const responses = [];
  const calls = [];
  const apiService = {
    getMyAuditFindings: async (value) => {
      calls.push(value);
      return value.discordUserId === actor.id
        ? [finding(), finding({ id: 8, name: 'Private actor finding' })]
        : [finding({ id: 9, name: 'Other actor finding' })];
    },
  };

  const first = makeInteraction('explain', { focused: 'private' }, actor);
  first.respond = async (choices) => { responses.push(choices); };
  await autocomplete(first, { apiService });

  const otherActor = { id: '987654321098765432' };
  const second = makeInteraction('explain', { focused: 'private' }, otherActor);
  second.respond = async (choices) => { responses.push(choices); };
  await autocomplete(second, { apiService });

  assert.deepEqual(responses, [
    [{ name: 'Private actor finding · #8', value: '8' }],
    [],
  ]);
  assert.deepEqual(calls.map((value) => value.discordUserId), [actor.id, otherActor.id]);
});

test('audit acknowledge and snooze show session-bound confirmations and call Nexus only after confirmation', async () => {
  const sessions = sessionStore();
  const calls = [];
  const apiService = {
    getMyAuditFindings: async () => [finding()],
    acknowledgeAuditFinding: async (_actor, id, payload) => {
      calls.push(['ack', id, payload]);
      return { message: 'Acknowledgement recorded.' };
    },
    snoozeAuditFinding: async (_actor, id, payload) => {
      calls.push(['snooze', id, payload]);
      return { message: 'Reminder snoozed.' };
    },
  };

  const acknowledge = makeInteraction('acknowledge', { finding: 7, note: 'Working on it' });
  await execute(acknowledge, { apiService, sessions });
  assert.match(embedJson(acknowledge.replies[0]).title, /Confirm Audit Acknowledgement/);
  const acknowledgeButtons = acknowledge.replies[0].components[0].toJSON().components;
  const acknowledgeSession = sessions.resolve(acknowledgeButtons[0].custom_id, actor.id);
  const acknowledgeConfirmation = makeButtonInteraction(acknowledgeButtons[0].custom_id);
  await button(acknowledgeConfirmation, { apiService, sessions, session: acknowledgeSession });

  const snooze = makeInteraction('snooze', { finding: 7, hours: 72 });
  await execute(snooze, { apiService, sessions });
  assert.match(embedJson(snooze.replies[0]).title, /Confirm Audit Snooze/);
  const snoozeButtons = snooze.replies[0].components[0].toJSON().components;
  const snoozeSession = sessions.resolve(snoozeButtons[0].custom_id, actor.id);
  const snoozeConfirmation = makeButtonInteraction(snoozeButtons[0].custom_id);
  await button(snoozeConfirmation, { apiService, sessions, session: snoozeSession });

  assert.deepEqual(calls, [
    ['ack', 7, { note: 'Working on it' }],
    ['snooze', 7, { hours: 72 }],
  ]);
  assert.match(embedJson(acknowledgeConfirmation.replies[0]).title, /Acknowledged/);
  assert.match(embedJson(snoozeConfirmation.replies[0]).title, /Snoozed/);
});

test('audit confirmation cancellation removes the action without calling Nexus', async () => {
  const sessions = sessionStore();
  let mutationCalled = false;
  const interaction = makeInteraction('acknowledge', { finding: 7 });
  await execute(interaction, {
    apiService: {
      getMyAuditFindings: async () => [finding()],
      acknowledgeAuditFinding: async () => { mutationCalled = true; },
    },
    sessions,
  });

  const buttons = interaction.replies[0].components[0].toJSON().components;
  const cancelSession = sessions.resolve(buttons[1].custom_id, actor.id);
  const cancel = makeButtonInteraction(buttons[1].custom_id);
  await button(cancel, { sessions, session: cancelSession });

  assert.equal(mutationCalled, false);
  assert.equal(embedJson(cancel.replies[0]).title, 'Audit Action Cancelled');
});

test('audit confirmation surfaces stale and not-found Nexus errors', async () => {
  const sessions = sessionStore();
  const apiService = {
    getMyAuditFindings: async () => [finding()],
    acknowledgeAuditFinding: async () => { throw { code: 'NOT_FOUND' }; },
    snoozeAuditFinding: async () => { throw { code: 'STALE_INTENT' }; },
  };

  const acknowledge = makeInteraction('acknowledge', { finding: 7 });
  await execute(acknowledge, { apiService, sessions });
  const acknowledgeButton = acknowledge.replies[0].components[0].toJSON().components[0];
  const acknowledgeSession = sessions.resolve(acknowledgeButton.custom_id, actor.id);
  const acknowledgeConfirmation = makeButtonInteraction(acknowledgeButton.custom_id);
  await button(acknowledgeConfirmation, { apiService, sessions, session: acknowledgeSession });
  assert.equal(embedJson(acknowledgeConfirmation.replies[0]).title, 'Request Failed');
  assert.match(embedJson(acknowledgeConfirmation.replies[0]).description, /no longer available/);

  const snooze = makeInteraction('snooze', { finding: 7, hours: 24 });
  await execute(snooze, { apiService, sessions });
  const snoozeButton = snooze.replies[0].components[0].toJSON().components[0];
  const snoozeSession = sessions.resolve(snoozeButton.custom_id, actor.id);
  const snoozeConfirmation = makeButtonInteraction(snoozeButton.custom_id);
  await button(snoozeConfirmation, { apiService, sessions, session: snoozeSession });
  assert.equal(embedJson(snoozeConfirmation.replies[0]).title, 'Request Failed');
  assert.match(embedJson(snoozeConfirmation.replies[0]).description, /changed or expired/);
});

test('expired audit controls are handled by the existing interaction dispatcher', async () => {
  let now = 1000;
  const sessions = new InteractionSessionStore({
    ttlMs: 10,
    now: () => now,
    createToken: () => 'expired-audit-control-token-123456',
  });
  const customId = sessions.create({
    commandName: 'audit', userId: actor.id, event: 'acknowledge-confirm', state: { finding: 7 },
  });
  now = 1011;

  const client = createEventClient();
  const logger = createLogger();
  registerInteractionListener(client, new Map([['audit', { button }]]), logger, { sessions }, '123456789012345678');
  const interaction = makeButtonInteraction(customId);
  await client.handlers.get(Events.InteractionCreate)(interaction);

  assert.equal(embedJson(interaction.replies[0]).title, 'Control Expired');
  assert.equal(interaction.replies[0].ephemeral, true);
  assert.equal(logger.entries.error.length, 0);
});

test('explain reports a finding that is missing from the actor-scoped result set', async () => {
  const interaction = makeInteraction('explain', { finding: '999' });
  await execute(interaction, {
    apiService: {
      getMyAuditFindings: async () => [finding()],
    },
    sessions: sessionStore(),
  });

  assert.equal(embedJson(interaction.replies[0]).title, 'Request Failed');
  assert.match(embedJson(interaction.replies[0]).description, /no longer available/);
});
