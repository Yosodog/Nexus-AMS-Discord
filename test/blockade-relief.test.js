import test from 'node:test';
import assert from 'node:assert/strict';
import * as command from '../src/commands/unblockade.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { validate as validatePrivateNotification } from '../src/services/queueActions/privateNotification.js';
import { createLogger, embedJson } from './helpers.js';

const USER_ID = '223456789012345678';
const GUILD_ID = '323456789012345678';

test('unblockade command exposes request, listing, claim, and cancel operations', () => {
  const json = command.data.toJSON();
  assert.equal(json.name, 'unblockade');
  assert.deepEqual(json.options.map((option) => option.name), ['request', 'mine', 'available', 'claim', 'cancel']);
  assert.equal(json.dm_permission, false);
});

const commandInteraction = (subcommand, values = {}) => {
  const interaction = {
    id: '423456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: {
      getSubcommand: () => subcommand,
      getInteger: (name) => values[name] ?? null,
      getString: (name) => values[name] ?? null,
    },
    defers: [],
    edits: [],
    deferReply: async (payload) => interaction.defers.push(payload),
    editReply: async (payload) => interaction.edits.push(payload),
  };
  return interaction;
};

const buttonInteraction = () => {
  const interaction = {
    id: '523456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    edits: [],
    updates: [],
    deferUpdate: async () => { interaction.deferred = true; },
    editReply: async (payload) => interaction.edits.push(payload),
    update: async (payload) => interaction.updates.push(payload),
  };
  return interaction;
};

const confirmation = async (subcommand, values, apiService, sessions) => {
  const interaction = commandInteraction(subcommand, values);
  await command.execute(interaction, { apiService, sessions });
  const components = interaction.edits[0].components[0].toJSON().components;
  return {
    interaction,
    confirm: sessions.resolve(components[0].custom_id, USER_ID),
    cancel: sessions.resolve(components[1].custom_id, USER_ID),
  };
};

const blockadeApi = (calls) => ({
  baseUrl: 'https://nexus.example',
  createBlockadeReliefRequest: async (actor, body) => {
    calls.push({ name: 'create', actor, body });
    return { id: 7, deadline_at: '2026-07-10T20:00:00Z' };
  },
  getMyBlockadeReliefRequests: async (actor) => {
    calls.push({ name: 'mine', actor });
    return [];
  },
  getAvailableBlockadeReliefRequests: async (actor) => {
    calls.push({ name: 'available', actor });
    return [];
  },
  claimBlockadeReliefRequest: async (actor, id) => {
    calls.push({ name: 'claim', actor, id });
    return { id, status: 'claimed' };
  },
  cancelBlockadeReliefRequest: async (actor, id) => {
    calls.push({ name: 'cancel', actor, id });
    return { id, status: 'cancelled' };
  },
});

test('unblockade reads use named API methods while mutations wait for confirmation', async () => {
  const calls = [];
  const apiService = blockadeApi(calls);
  const sessions = new InteractionSessionStore();

  const request = await confirmation('request', { war: 44, note: '  Please help  ' }, apiService, sessions);
  const claim = await confirmation('claim', { request: 8 }, apiService, sessions);
  const cancel = await confirmation('cancel', { request: 9 }, apiService, sessions);
  await command.execute(commandInteraction('mine'), { apiService, sessions });
  await command.execute(commandInteraction('available'), { apiService, sessions });

  assert.deepEqual(calls.map(({ name }) => name), ['mine', 'available']);
  assert.equal(calls.every(({ actor }) => actor.discordUserId === USER_ID), true);
  assert.equal(request.interaction.defers[0].ephemeral, true);
  assert.equal(embedJson(request.interaction.edits[0]).title, 'Confirm Relief Request');
  assert.deepEqual(request.confirm.state.body, { war_id: 44, deadline_hours: 6, note: 'Please help' });
  assert.equal(claim.confirm.state.id, 8);
  assert.equal(cancel.confirm.state.id, 9);
});

test('unblockade confirmed controls call Nexus once and cancellation is inert', async () => {
  const calls = [];
  const apiService = blockadeApi(calls);
  const sessions = new InteractionSessionStore();
  const prepared = [
    await confirmation('request', { war: 44, deadline: 12, note: '  Please help  ' }, apiService, sessions),
    await confirmation('claim', { request: 8 }, apiService, sessions),
    await confirmation('cancel', { request: 9 }, apiService, sessions),
  ];

  for (const item of prepared) {
    const interaction = buttonInteraction();
    await command.button(interaction, { apiService, session: item.confirm });
    assert.equal(interaction.deferred, true);
    assert.ok(['Relief Request Opened', 'Relief Request Claimed', 'Relief Request Cancelled']
      .includes(embedJson(interaction.edits[0]).title));
  }

  assert.deepEqual(calls.map(({ name }) => name), ['create', 'claim', 'cancel']);
  assert.deepEqual(calls[0].body, { war_id: 44, deadline_hours: 12, note: 'Please help' });
  assert.equal(calls[1].id, 8);
  assert.equal(calls[2].id, 9);
  assert.equal(calls.every(({ actor }) => actor.discordUserId === USER_ID), true);

  const cancelled = await confirmation('claim', { request: 10 }, apiService, sessions);
  const cancelInteraction = buttonInteraction();
  await command.button(cancelInteraction, { apiService, session: cancelled.cancel });
  assert.equal(calls.length, 3);
  assert.equal(embedJson(cancelInteraction.updates[0]).title, 'Blockade Relief Action Cancelled');
});

test('blockade relief is accepted by the preference-aware private renderer', () => {
  assert.deepEqual(validatePrivateNotification({
    contract_version: 1,
    event_type: 'blockade_relief_created',
    recipient_discord_id: USER_ID,
    notification_id: 'blockade-relief:7:created:101:1',
    deep_link_path: '/defense/blockade-relief',
    subject: { type: 'blockade_relief_request', id: 7, label: 'Request #7' },
    summary: { status: 'pending', event: 'created' },
  }), { valid: true });
});
