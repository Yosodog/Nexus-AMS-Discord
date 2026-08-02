import test from 'node:test';
import assert from 'node:assert/strict';
import * as command from '../src/commands/unblockade.js';
import * as notification from '../src/services/queueActions/blockadeReliefNotification.js';
import { validate as validatePrivateNotification } from '../src/services/queueActions/privateNotification.js';
import { createLogger } from './helpers.js';

const USER_ID = '223456789012345678';

const payload = {
  contract_version: 1,
  event_type: 'created',
  request_id: 7,
  war_id: 44,
  status: 'pending',
  recipient_discord_ids: [USER_ID],
  requester: { id: 101, name: 'Friendly Nation' },
  blockader: { id: 202, name: 'Enemy Nation' },
  deadline_at: '2026-07-10T20:00:00Z',
  deep_link_path: '/defense/blockade-relief',
};

test('unblockade command exposes request, listing, claim, and cancel operations', () => {
  const json = command.data.toJSON();
  assert.equal(json.name, 'unblockade');
  assert.deepEqual(json.options.map((option) => option.name), ['request', 'mine', 'available', 'claim', 'cancel']);
  assert.equal(json.dm_permission, false);
});

test('blockade relief queue action validates a strict operational payload', () => {
  assert.deepEqual(notification.validate(payload), { valid: true });
  assert.deepEqual(notification.validate({ ...payload, event_type: 'message' }), {
    valid: false, reason: 'invalid_event_type',
  });
  assert.deepEqual(notification.validate({ ...payload, recipient_discord_ids: [] }), {
    valid: false, reason: 'invalid_recipients',
  });
  assert.deepEqual(notification.validate({ ...payload, deep_link_path: 'https://example.test' }), {
    valid: false, reason: 'invalid_deep_link',
  });
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

test('blockade relief queue action sends deterministic safe DMs and reports outcomes', async () => {
  const sent = [];
  const runtime = {
    apiService: { baseUrl: 'https://nexus.example' },
    logger: createLogger(),
    canContinue: () => true,
    resolveUser: async (id) => ({ id }),
    sendDirectMessage: async (user, _command, step, message) => {
      sent.push({ user, step, message });
      return { id: 'dm-1' };
    },
  };

  const result = await notification.execute({
    id: 'queue-1',
    created_at: '2026-07-10T12:00:00Z',
    payload,
  }, runtime);

  assert.deepEqual(result, { success: true, result: { delivered: 1, undeliverable: 0 } });
  assert.equal(sent[0].user.id, USER_ID);
  assert.equal(sent[0].step, `blockade-relief-${USER_ID}`);
  assert.deepEqual(sent[0].message.allowedMentions, { parse: [], repliedUser: false });
  const embed = sent[0].message.embeds[0].toJSON();
  assert.equal(embed.url, 'https://nexus.example/defense/blockade-relief');
  assert.match(embed.description, /Open relief request in Nexus/);
  assert.deepEqual(embed.fields.map((field) => field.name), ['Request', 'War', 'Deadline']);
  assert.match(embed.fields[0].value, /#7.*Friendly Nation.*Enemy Nation/);
});

test('closed blockade relief notices label the historical deadline clearly', async () => {
  let message;
  await notification.execute({
    id: 'queue-closed',
    created_at: '2026-07-10T21:00:00Z',
    payload: { ...payload, event_type: 'resolved' },
  }, {
    apiService: { baseUrl: 'https://nexus.example' },
    logger: createLogger(),
    canContinue: () => true,
    resolveUser: async (id) => ({ id }),
    sendDirectMessage: async (_user, _command, _step, outgoing) => {
      message = outgoing;
      return { id: 'dm-closed' };
    },
  });

  assert.deepEqual(message.embeds[0].toJSON().fields.map((field) => field.name), [
    'Request', 'War', 'Deadline was',
  ]);
});
