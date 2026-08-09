import test from 'node:test';
import assert from 'node:assert/strict';
import { execute as executeApprove } from '../src/commands/approve.js';
import { execute as executeDeny } from '../src/commands/deny.js';
import {
  button as handleApplicationButton,
  execute as executeApplications,
  modal as handleApplicationModal,
} from '../src/commands/applications.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { embedJson } from './helpers.js';

const GUILD_ID = '123456789012345678';
const APPLICANT_ID = '223456789012345678';
const MODERATOR_ID = '323456789012345678';
const BASE_URL = 'https://nexus.example';

const createSessions = () => {
  let sequence = 0;
  return new InteractionSessionStore({
    createToken: () => `${++sequence}`.padStart(16, '0'),
  });
};

const componentId = (message) => message.components[0].toJSON().components[0].custom_id;

const baseInteraction = () => {
  const interaction = {
    id: '423456789012345678',
    guildId: GUILD_ID,
    user: { id: MODERATOR_ID },
    deferred: false,
    replied: false,
    replies: [],
    edits: [],
    updates: [],
    modals: [],
    reply: async (payload) => {
      interaction.replied = true;
      interaction.replies.push(payload);
      return payload;
    },
    deferReply: async () => { interaction.deferred = true; },
    deferUpdate: async () => { interaction.deferred = true; },
    editReply: async (payload) => {
      interaction.edits.push(payload);
      return payload;
    },
    update: async (payload) => {
      interaction.replied = true;
      interaction.updates.push(payload);
      return payload;
    },
    showModal: async (payload) => {
      interaction.replied = true;
      interaction.modals.push(payload);
      return payload;
    },
  };
  return interaction;
};

const aliasInteraction = () => {
  const interaction = baseInteraction();
  interaction.options = {
    getUser: () => ({
      id: APPLICANT_ID,
      username: 'applicant.example',
      globalName: 'Applicant Example',
    }),
  };
  return interaction;
};

const decisionApi = ({ matches = [{ token: 'opaque-application', leader_name: 'Applicant Example' }] } = {}) => {
  const calls = { lookups: [], decisions: [] };
  return {
    calls,
    service: {
      baseUrl: BASE_URL,
      getStaffApplications: async (actor, query) => {
        calls.lookups.push({ actor, query });
        return { items: matches };
      },
      decideStaffApplication: async (actor, application, decision, payload) => {
        calls.decisions.push({ actor, application, decision, payload });
        return {
          application: {
            id: 42,
            token: application,
            leader_name: 'Applicant Example',
            status: decision === 'approve' ? 'approved' : 'denied',
            deep_link_path: '/admin/applications/42',
          },
        };
      },
    },
  };
};

test('/approve is a confirmation-only alias of the canonical applications handler', async () => {
  const sessions = createSessions();
  const interaction = aliasInteraction();
  const { service: apiService, calls } = decisionApi();

  await executeApprove(interaction, { apiService, sessions });

  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].ephemeral, true);
  assert.equal(embedJson(interaction.replies[0]).title, 'Confirm Application Approval');
  assert.deepEqual(calls.decisions, []);

  const session = sessions.resolve(componentId(interaction.replies[0]), MODERATOR_ID);
  assert.deepEqual(session, {
    commandName: 'applications',
    userId: MODERATOR_ID,
    event: 'approve-confirm',
    state: { applicantDiscordId: APPLICANT_ID, target: 'Applicant Example' },
    oneShot: true,
    connectionId: null,
    generation: null,
    guildId: null,
    expiresAt: session.expiresAt,
  });

  const confirmation = baseInteraction();
  await handleApplicationButton(confirmation, { apiService, sessions, session });

  assert.deepEqual(calls.lookups, [{
    actor: {
      discordUserId: MODERATOR_ID,
      discordGuildId: GUILD_ID,
      discordInteractionId: confirmation.id,
      discordCommand: 'applications',
      discordAction: 'applications',
    },
    query: { applicant_discord_id: APPLICANT_ID, filter: 'pending', limit: 2 },
  }]);
  assert.deepEqual(calls.decisions, [{
    actor: {
      discordUserId: MODERATOR_ID,
      discordGuildId: GUILD_ID,
      discordInteractionId: confirmation.id,
      discordCommand: 'applications',
      discordAction: 'applications',
    },
    application: 'opaque-application',
    decision: 'approve',
    payload: {},
  }]);
  assert.equal(embedJson(confirmation.edits[0]).title, 'Application Approved');
  assert.equal('guild' in confirmation, false, 'the canonical handler must not mutate Discord directly');
});

test('/deny uses the canonical reason modal, confirmation, lookup, and decision handler', async () => {
  const sessions = createSessions();
  const interaction = aliasInteraction();
  const { service: apiService, calls } = decisionApi();

  await executeDeny(interaction, { apiService, sessions });

  assert.equal(interaction.modals.length, 1);
  assert.deepEqual(calls.decisions, []);
  const modalJson = interaction.modals[0].toJSON();
  const reasonId = modalJson.components[0].components[0].custom_id;
  const modalSession = sessions.resolve(modalJson.custom_id, MODERATOR_ID);
  assert.equal(modalSession.commandName, 'applications');
  assert.equal(modalSession.event, 'deny-reason');
  assert.equal(modalSession.state.applicantDiscordId, APPLICANT_ID);

  const submission = baseInteraction();
  submission.fields = { getTextInputValue: (field) => {
    assert.equal(field, reasonId);
    return 'Application requirements were not completed.';
  } };
  await handleApplicationModal(submission, {
    apiService,
    sessions,
    session: modalSession,
  });

  assert.equal(embedJson(submission.replies[0]).title, 'Confirm Application Denial');
  const confirmationSession = sessions.resolve(componentId(submission.replies[0]), MODERATOR_ID);
  assert.equal(confirmationSession.commandName, 'applications');
  assert.equal(confirmationSession.event, 'deny-confirm');

  const confirmation = baseInteraction();
  await handleApplicationButton(confirmation, {
    apiService,
    sessions,
    session: confirmationSession,
  });

  assert.equal(calls.decisions.length, 1);
  assert.deepEqual(calls.decisions[0], {
    actor: {
      discordUserId: MODERATOR_ID,
      discordGuildId: GUILD_ID,
      discordInteractionId: confirmation.id,
      discordCommand: 'applications',
      discordAction: 'applications',
    },
    application: 'opaque-application',
    decision: 'deny',
    payload: { reason: 'Application requirements were not completed.' },
  });
  assert.equal(embedJson(confirmation.edits[0]).title, 'Application Denied');
  assert.equal('guild' in confirmation, false, 'the canonical handler must not mutate Discord directly');
});

test('/applications approve and /approve create the same canonical confirmation event', async () => {
  const canonicalSessions = createSessions();
  const canonical = baseInteraction();
  canonical.options = {
    getSubcommand: () => 'approve',
    getString: () => 'opaque-application',
  };
  await executeApplications(canonical, {
    apiService: { baseUrl: BASE_URL },
    sessions: canonicalSessions,
  });
  const canonicalSession = canonicalSessions.resolve(componentId(canonical.edits[0]), MODERATOR_ID);

  const aliasSessions = createSessions();
  const alias = aliasInteraction();
  await executeApprove(alias, {
    apiService: { baseUrl: BASE_URL },
    sessions: aliasSessions,
  });
  const aliasSession = aliasSessions.resolve(componentId(alias.replies[0]), MODERATOR_ID);

  assert.equal(canonicalSession.commandName, 'applications');
  assert.equal(aliasSession.commandName, 'applications');
  assert.equal(canonicalSession.event, 'approve-confirm');
  assert.equal(aliasSession.event, canonicalSession.event);
});

test('alias lookup fails closed for ambiguous applications and unknown controls never mutate', async () => {
  const sessions = createSessions();
  const interaction = aliasInteraction();
  const { service: apiService, calls } = decisionApi({
    matches: [{ token: 'first' }, { token: 'second' }],
  });
  await executeApprove(interaction, { apiService, sessions });
  const session = sessions.resolve(componentId(interaction.replies[0]), MODERATOR_ID);
  const confirmation = baseInteraction();
  await handleApplicationButton(confirmation, { apiService, sessions, session });

  assert.deepEqual(calls.decisions, []);
  assert.equal(embedJson(confirmation.edits[0]).title, 'Request Failed');
  assert.match(embedJson(confirmation.edits[0]).description, /More than one pending application/);

  const unknown = baseInteraction();
  await handleApplicationButton(unknown, {
    apiService,
    sessions,
    session: { event: 'unexpected', state: {} },
  });
  assert.deepEqual(calls.decisions, []);
  assert.equal(embedJson(unknown.replies[0]).title, 'Request Failed');
});

test('/applications status renders Nexus-owned steps, remediation, freshness, and a safe continuation', async () => {
  const interaction = baseInteraction();
  interaction.options = { getSubcommand: () => 'status' };
  const apiService = {
    baseUrl: BASE_URL,
    getMyApplications: async () => ({
      data: [{
        id: 42,
        status: 'pending',
        created_at: '2026-08-08T12:00:00Z',
        updated_at: '2026-08-08T12:05:00Z',
        deep_link_path: '/apply?application=42',
        channel_health: {
          state: 'ready',
          label: 'Private interview channel is ready.',
          channel_id: '523456789012345678',
        },
        progress: {
          facts: [
            { key: 'submitted', label: 'Application submitted to Nexus', complete: true },
            { key: 'staff_decision', label: 'Staff decision recorded', complete: false },
          ],
          blockers: [{
            code: 'discord_follow_up_needs_staff',
            message: 'Staff need to repair one Discord follow-up step.',
          }],
          next_action: {
            label: 'Continue your application in Nexus',
            deep_link_path: '/apply?application=42',
          },
        },
        reconciliation: {
          state: 'attention',
          label: 'Discord follow-up needs staff attention.',
          revision: 2,
          issues_count: 1,
          updated_at: '2026-08-08T12:05:00Z',
        },
      }],
      meta: { total: 1 },
    }),
  };

  await executeApplications(interaction, { apiService, sessions: createSessions() });

  const payload = interaction.edits[0];
  const embed = embedJson(payload);
  const rendered = JSON.stringify(embed);
  assert.equal(embed.title, 'Your Applications');
  assert.match(rendered, /Application submitted to Nexus/);
  assert.match(rendered, /Staff decision recorded/);
  assert.ok(embed.fields[0].value.includes('Staff need to repair one Discord follow\\-up step\\.'));
  assert.match(rendered, /<#523456789012345678>/);
  assert.match(rendered, /Updated/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.components[0].toJSON().components[0].style, 5);
  assert.equal(
    payload.components[0].toJSON().components[0].url,
    'https://nexus.example/apply?application=42',
  );
});

test('/applications status supports old Nexus projections and rejects external continuation links', async () => {
  const legacy = baseInteraction();
  legacy.options = { getSubcommand: () => 'status' };
  await executeApplications(legacy, {
    apiService: {
      baseUrl: BASE_URL,
      getMyApplications: async () => [{
        id: 41,
        status: 'pending',
        created_at: '2026-08-08T12:00:00Z',
        deep_link_path: '/apply?application=41',
      }],
    },
    sessions: createSessions(),
  });
  assert.equal(embedJson(legacy.edits[0]).title, 'Your Applications');

  const external = baseInteraction();
  external.options = { getSubcommand: () => 'status' };
  await executeApplications(external, {
    apiService: {
      baseUrl: BASE_URL,
      getMyApplications: async () => [{
        id: 42,
        status: 'pending',
        deep_link_path: 'https://attacker.example/apply',
        channel_health: { state: 'unknown', label: 'Channel status is unknown.' },
        progress: {
          facts: [],
          blockers: [],
          next_action: { label: 'Leave Nexus', deep_link_path: 'https://attacker.example/' },
        },
        reconciliation: { state: 'not_requested', label: 'Not requested.' },
      }],
    },
    sessions: createSessions(),
  });
  assert.deepEqual(external.edits[0].components, []);
  assert.doesNotMatch(JSON.stringify(external.edits[0]), /attacker\.example|Leave Nexus/);
});
