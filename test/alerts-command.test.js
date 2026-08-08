import test from 'node:test';
import assert from 'node:assert/strict';
import { data, execute } from '../src/commands/alerts.js';
import {
  execute as executePrivateNotification,
  validate as validatePrivateNotification,
} from '../src/services/queueActions/privateNotification.js';
import { embedJson } from './helpers.js';

const interaction = (subcommand, values = {}) => {
  const replies = [];
  return {
    id: '123456789012345678',
    guildId: '234567890123456789',
    user: { id: '345678901234567890' },
    deferred: false,
    replied: false,
    replies,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => values[name] ?? null,
      getInteger: (name) => values[name] ?? null,
      getNumber: (name) => values[name] ?? null,
    },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => { replies.push(payload); },
  };
};

test('alerts command exposes controlled subcommands', () => {
  const json = data.toJSON();
  assert.equal(json.name, 'alerts');
  assert.deepEqual(json.options.map((option) => option.name), ['list', 'nation', 'alliance', 'market', 'manage']);
});

test('market alert forwards a typed payload to Nexus', async () => {
  const calls = [];
  const subject = interaction('market', {
    resource: 'steel', direction: 'below', price: 3000, cooldown: 30, name: 'Cheap steel',
  });
  await execute(subject, {
    apiService: {
      createAlert: async (actor, payload) => {
        calls.push({ actor, payload });
        return { id: 7, name: 'Cheap steel' };
      },
    },
  });

  assert.equal(calls[0].actor.discordUserId, subject.user.id);
  assert.deepEqual(calls[0].payload, {
    name: 'Cheap steel', cooldown_minutes: 30, type: 'market', resource: 'steel', direction: 'below', threshold: 3000,
  });
  const embed = embedJson(subject.replies[0]);
  assert.equal(embed.title, 'Alert Created');
  assert.match(embed.description, /#7/);
  assert.match(embed.description, /Cheap steel/);
});

test('manage pause sends an ownership-scoped status update', async () => {
  const calls = [];
  const subject = interaction('manage', { id: 9, action: 'pause' });
  await execute(subject, {
    apiService: {
      updateAlertStatus: async (actor, id, isActive) => {
        calls.push({ actor, id, isActive });
        return {};
      },
    },
  });

  assert.equal(calls[0].actor.discordUserId, subject.user.id);
  assert.equal(calls[0].id, 9);
  assert.equal(calls[0].isActive, false);
});

test('watchlist private notification payload is accepted by the shared renderer', () => {
  assert.deepEqual(validatePrivateNotification({
    contract_version: 1,
    event_type: 'watchlist_triggered',
    recipient_discord_id: '345678901234567890',
    notification_id: 'watchlist-9-state',
    deep_link_path: '/user/alerts',
    subject: { type: 'alert_subscription', id: 9, label: 'Steel spike' },
    summary: { status: 'triggered', event: 'Steel crossed above 4000' },
  }), { valid: true });
});

test('watchlist private notification renders the trigger reason', async () => {
  let message;
  const command = {
    payload: {
      contract_version: 1,
      event_type: 'watchlist_triggered',
      recipient_discord_id: '345678901234567890',
      notification_id: 'watchlist-9-state',
      deep_link_path: '/user/alerts',
      subject: { type: 'alert_subscription', id: 9, label: 'Steel spike' },
      summary: { status: 'triggered', event: 'Steel crossed above 4000' },
    },
  };

  const result = await executePrivateNotification(command, {
    canContinue: () => true,
    resolveUser: async () => ({ id: '345678901234567890' }),
    sendDirectMessage: async (_user, _command, _key, outgoing) => {
      message = outgoing;
      return { id: '456789012345678901' };
    },
    logger: { warn: () => {} },
  });

  assert.equal(result.success, true);
  assert.match(message.embeds[0].data.description, /Steel crossed above 4000/);
});
