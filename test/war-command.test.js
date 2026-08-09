import test from 'node:test';
import assert from 'node:assert/strict';
import { autocomplete, button, data, execute, modal } from '../src/commands/war.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { embedJson } from './helpers.js';

const USER_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';

const sessions = () => {
  let sequence = 0;
  return new InteractionSessionStore({
    createToken: () => `war${String(sequence += 1).padStart(30, '0')}`,
  });
};

const buttonInteraction = (customId) => {
  const replies = [];
  const modals = [];
  const interaction = {
    customId,
    id: '423456789012345678',
    commandName: 'war',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    deferred: false,
    deferUpdate: async () => { interaction.deferred = true; },
    editReply: async (payload) => { replies.push(payload); return payload; },
    update: async (payload) => { replies.push(payload); return payload; },
    showModal: async (payload) => { modals.push(payload); return payload; },
    reply: async (payload) => { replies.push(payload); return payload; },
    replies,
    modals,
  };
  return interaction;
};

const modalInteraction = (customId, reason) => {
  const replies = [];
  const interaction = {
    customId,
    id: '523456789012345678',
    commandName: 'war',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    deferred: false,
    fields: { getTextInputValue: () => reason },
    deferReply: async ({ ephemeral }) => {
      assert.equal(ephemeral, true);
      interaction.deferred = true;
    },
    editReply: async (payload) => { replies.push(payload); return payload; },
    reply: async (payload) => { replies.push(payload); return payload; },
    replies,
  };
  return interaction;
};

const assignment = (overrides = {}) => ({
  assignment_id: 8,
  status: 'approved',
  rank: 1,
  operation: { name: 'Shield', wave: 2 },
  objective: { id: 19, status: 'approved', priority: 'p1', war_type: 'ordinary' },
  target: { id: 99, nation_name: 'Target Nation', alliance: { name: 'Target AA' } },
  room: { available: true, discord_channel_id: '423456789012345678' },
  links: { target_nation: 'https://politicsandwar.com/nation/id=99' },
  ...overrides,
});

test('/war keeps Milcom responses inside the assignments view instead of legacy subcommands', () => {
  const subcommands = data.toJSON().options.map((option) => option.name);
  assert.deepEqual(subcommands, ['active', 'assignments', 'readiness', 'room', 'counter', 'simulate']);
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

test('/war readiness autocomplete uses the Nexus nation directory', async () => {
  const responses = [];
  const calls = [];
  const interaction = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: {
      getFocused: () => ({ name: 'nation', value: 'alpha' }),
      getSubcommand: () => 'readiness',
    },
    respond: async (choices) => { responses.push(choices); },
  };
  await autocomplete(interaction, {
    apiService: {
      searchDirectoryNations: async (...args) => {
        calls.push(args);
        return { items: [{ id: 44, name: 'Alpha Nation', description: 'Leader Alpha' }] };
      },
    },
  });
  assert.deepEqual(responses[0], [{ name: 'Alpha Nation · Leader Alpha', value: '44' }]);
  assert.equal(calls[0][1], 'alpha');
});

test('/war assignments renders only the Milcom-v2 projection', async () => {
  const replies = [];
  const store = sessions();
  const interaction = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: { getSubcommand: () => 'assignments' },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  };
  await execute(interaction, {
    apiService: {
      getMilcomAssignments: async () => [assignment({
        private_notes: 'must not render',
      })],
    },
    sessions: store,
  });
  const embed = embedJson(replies[0]);
  assert.match(embed.title, /Milcom-v2 Assignments/);
  assert.match(JSON.stringify(embed), /Target Nation/);
  assert.doesNotMatch(JSON.stringify(embed), /must not render/);
  assert.deepEqual(replies[0].allowedMentions, { parse: [] });
  assert.equal(replies[0].components.length, 1);
  const controls = replies[0].components[0].toJSON().components;
  assert.deepEqual(controls.map((control) => control.label), ['Acknowledge #8', 'Unavailable #8']);
  assert.equal(store.resolve(controls[0].custom_id, USER_ID).event, 'assignment-acknowledge-start');
});

test('/war assignment acknowledgement uses Nexus preview then opaque-intent confirmation', async () => {
  const store = sessions();
  const calls = [];
  const apiService = {
    previewMilcomAssignmentResponse: async (actor, id, payload) => {
      calls.push(['preview', actor, id, payload]);
      return {
        intent: { id: 'a'.repeat(64), expires_at: '2026-08-09T12:15:00Z' },
        assignment: assignment(),
        proposed_response: { response: 'acknowledged', reason: null },
      };
    },
    confirmMilcomAssignmentResponse: async (actor, id, intentId) => {
      calls.push(['confirm', actor, id, intentId]);
      return { assignment_type: 'milcom_v2', assignment_id: id, response: 'acknowledged' };
    },
  };
  const startId = store.create({
    commandName: 'war', userId: USER_ID,
    event: 'assignment-acknowledge-start', state: { assignmentId: 8 }, oneShot: true,
  });
  const start = buttonInteraction(startId);
  await button(start, { apiService, sessions: store, session: store.resolve(startId, USER_ID) });

  assert.deepEqual(calls[0].slice(0, 1), ['preview']);
  assert.equal(calls[0][1].discordCommand, 'war');
  assert.deepEqual(calls[0].slice(2), [8, { response: 'acknowledged' }]);
  assert.match(embedJson(start.replies[0]).title, /Confirm Assignment Acknowledgement/);
  const confirmationId = start.replies[0].components[0].toJSON().components[0].custom_id;
  const confirm = buttonInteraction(confirmationId);
  await button(confirm, {
    apiService,
    sessions: store,
    session: store.resolve(confirmationId, USER_ID),
  });

  assert.deepEqual(calls[1].slice(0, 1), ['confirm']);
  assert.equal(calls[1][1].discordCommand, 'war');
  assert.deepEqual(calls[1].slice(2), [8, 'a'.repeat(64)]);
  assert.match(embedJson(confirm.replies[0]).title, /Assignment Acknowledged/);
});

test('/war unavailable response requires a modal reason before Nexus preview', async () => {
  const store = sessions();
  const calls = [];
  const apiService = {
    previewMilcomAssignmentResponse: async (...args) => {
      calls.push(args);
      return {
        intent: { id: 'b'.repeat(64), expires_at: '2026-08-09T12:15:00Z' },
        assignment: assignment(),
        proposed_response: { response: 'unavailable', reason: 'No offensive slot.' },
      };
    },
  };
  const startId = store.create({
    commandName: 'war', userId: USER_ID,
    event: 'assignment-unavailable-start', state: { assignmentId: 8 }, oneShot: true,
  });
  const start = buttonInteraction(startId);
  await button(start, { sessions: store, session: store.resolve(startId, USER_ID) });

  assert.equal(calls.length, 0);
  assert.equal(start.modals.length, 1);
  const modalJson = start.modals[0].toJSON();
  const reasonInput = modalJson.components[0].components[0];
  assert.equal(reasonInput.max_length, 500);
  const modalSession = store.resolve(modalJson.custom_id, USER_ID);
  const submitted = modalInteraction(modalJson.custom_id, '  No offensive slot.  ');
  submitted.fields.getTextInputValue = (customId) => {
    assert.equal(customId, modalSession.state.reasonId);
    return '  No offensive slot.  ';
  };
  await modal(submitted, { apiService, sessions: store, session: modalSession });

  assert.equal(calls[0][0].discordCommand, 'war');
  assert.deepEqual(calls[0].slice(1), [8, {
    response: 'unavailable', reason: 'No offensive slot.',
  }]);
  assert.match(embedJson(submitted.replies[0]).title, /Confirm Assignment Unavailable/);
  assert.match(JSON.stringify(embedJson(submitted.replies[0])), /No offensive slot/);
});

test('/war assignment confirmation renders stale Nexus errors without a local state change', async () => {
  const store = sessions();
  const controlId = store.create({
    commandName: 'war', userId: USER_ID,
    event: 'assignment-response-confirm',
    state: { assignmentId: 8, intentId: 'c'.repeat(64) },
    oneShot: true,
  });
  const interaction = buttonInteraction(controlId);
  await button(interaction, {
    sessions: store,
    session: store.resolve(controlId, USER_ID),
    apiService: {
      confirmMilcomAssignmentResponse: async () => {
        throw { code: 'STALE_INTENT' };
      },
    },
  });

  assert.equal(embedJson(interaction.replies[0]).title, 'Request Failed');
  assert.match(embedJson(interaction.replies[0]).description, /changed or expired/);
});

test('/war assignments limits response controls to Discord five-row maximum', async () => {
  const replies = [];
  const interaction = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: { getSubcommand: () => 'assignments' },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  };
  await execute(interaction, {
    apiService: {
      getMilcomAssignments: async () => Array.from({ length: 7 }, (_, index) => assignment({
        assignment_id: index + 1,
        target: { id: 100 + index, nation_name: `Target ${index + 1}` },
      })),
    },
    sessions: sessions(),
  });

  assert.equal(replies[0].components.length, 5);
  assert.match(embedJson(replies[0]).footer.text, /first 5/);
});

test('/war readiness does not calculate policy in Discord', async () => {
  const replies = [];
  const calls = [];
  const interaction = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: {
      getSubcommand: () => 'readiness',
      getString: () => null,
    },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  };
  await execute(interaction, {
    apiService: {
      getMilcomReadiness: async (...args) => {
        calls.push(args);
        return {
          nation: { id: 7, nation_name: 'Ready Nation', leader_name: 'Leader' },
          score: 1234.5,
          cities: 20,
          vacation_turns: 0,
          beige_turns: 3,
          offensive_slots: { capacity_at_snapshot: 5, active_wars_at_snapshot: 2, reserved_at_snapshot: 1 },
          military: { soldiers: 100000, tanks: 5000, aircraft: 1200, ships: 80 },
          freshness: { fetched_at: '2026-08-09T12:00:00Z', completeness_percent: 97 },
          readiness_decision: 'must not render',
        };
      },
    },
  });
  const embed = embedJson(replies[0]);
  assert.match(embed.description, /does not recalculate readiness/);
  assert.match(JSON.stringify(embed), /Capacity/);
  assert.doesNotMatch(JSON.stringify(embed), /available|must not render/i);
  assert.deepEqual(calls[0][1], {});
});

test('/war room renders the actor-safe Nexus summary', async () => {
  const replies = [];
  const calls = [];
  const interaction = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: {
      getSubcommand: () => 'room',
      getInteger: () => 19,
    },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  };
  await execute(interaction, {
    apiService: {
      getMilcomWarRoom: async (...args) => {
        calls.push(args);
        return {
          objective_id: 19,
          discord_channel_id: '423456789012345678',
          status: 'engaged',
          priority: 'p1',
          war_type: 'ordinary',
          operation: { name: 'Shield', type: 'defensive', wave: 2 },
          target: { id: 99, nation_name: 'Target Nation', leader_name: 'Target Leader', score: 1400, cities: 20 },
          assigned_members: [{ assignment_id: 8, status: 'engaged', nation: { id: 7, nation_name: 'Ready Nation' } }],
          links: { target_nation: 'https://politicsandwar.com/nation/id=99' },
          recommendation_score: 'must not render',
        };
      },
    },
  });
  const embed = embedJson(replies[0]);
  assert.match(embed.title, /Target Nation/);
  assert.match(JSON.stringify(embed), /Ready Nation/);
  assert.doesNotMatch(JSON.stringify(embed), /must not render/);
  assert.equal(calls[0][1], 19);
  assert.deepEqual(replies[0].allowedMentions, { parse: [] });
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
