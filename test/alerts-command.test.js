import test from 'node:test';
import assert from 'node:assert/strict';
import * as command from '../src/commands/alerts.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import {
  execute as executePrivateNotification,
  validate as validatePrivateNotification,
} from '../src/services/queueActions/privateNotification.js';
import { embedJson } from './helpers.js';

const USER_ID = '345678901234567890';
const GUILD_ID = '234567890123456789';

const commandInteraction = (subcommand, values = {}) => {
  const subject = {
    id: '123456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    deferred: false,
    deferPayloads: [],
    edits: [],
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => values[name] ?? null,
      getInteger: (name) => values[name] ?? null,
      getNumber: (name) => values[name] ?? null,
      getBoolean: (name) => values[name] ?? null,
    },
    deferReply: async (payload) => {
      subject.deferred = true;
      subject.deferPayloads.push(payload);
    },
    editReply: async (payload) => {
      subject.edits.push(payload);
      return payload;
    },
  };
  return subject;
};

const componentInteraction = (values = []) => {
  const subject = {
    id: '423456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    values,
    deferred: false,
    edits: [],
    updates: [],
    deferUpdate: async () => { subject.deferred = true; },
    editReply: async (payload) => {
      subject.edits.push(payload);
      return payload;
    },
    update: async (payload) => {
      subject.updates.push(payload);
      return payload;
    },
  };
  return subject;
};

const customId = (message, component = 0, row = 0) => message.components[row].toJSON().components[component].custom_id;
const session = (message, sessions, component = 0, row = 0) => sessions.resolve(customId(message, component, row), USER_ID);

const settings = (overrides = {}) => ({
  timezone: 'UTC',
  quiet_hours: { enabled: false, start: null, end: null },
  default_digest: { time: '09:00', weekday: 1 },
  discord_enabled: false,
  uses_legacy_defaults: false,
  ...overrides,
});

const preview = (payload) => ({
  name: payload.name ?? (payload.type === 'market' ? 'Steel price' : `${payload.type} #${payload.target_id}`),
  type: payload.type,
  type_label: payload.type === 'market' ? 'Market' : payload.type === 'nation' ? 'Nation' : 'Alliance',
  target_id: payload.target_id ?? null,
  events: (payload.events ?? []).map((key) => ({ key, label: key.replaceAll('.', ' ') })),
  condition: payload.type === 'market'
    ? `${payload.resource} ${payload.direction} ${payload.threshold}`
    : (payload.events ?? []).join(', '),
  cooldown_minutes: payload.cooldown_minutes,
  rearm_percent: payload.rearm_percent ?? 1,
  expires_at: payload.expires_at ?? null,
  baseline_state: 'established_after_save',
  can_save: true,
  delivery: {
    mode: payload.delivery_mode,
    discord_enabled: payload.discord_enabled,
    timezone: payload.timezone ?? null,
  },
});

test('alerts command exposes v2 surfaces without assignment alert choices', () => {
  const json = command.data.toJSON();
  assert.equal(json.name, 'alerts');
  assert.deepEqual(json.options.map((option) => option.name), [
    'list', 'activity', 'settings', 'nation', 'alliance', 'market', 'edit', 'manage',
  ]);
  assert.equal(json.dm_permission, false);
  assert.doesNotMatch(JSON.stringify(json), /war_assignment|spy_assignment/);
});

test('market creation previews a typed draft and waits for confirmation', async () => {
  const calls = [];
  const sessions = new InteractionSessionStore();
  const subject = commandInteraction('market', {
    resource: 'steel', direction: 'below', price: 3000, cooldown: 30, name: 'Cheap steel',
    delivery: 'daily', discord: true, rearm: 2,
  });
  const apiService = {
    baseUrl: 'https://nexus.example',
    previewAlert: async (actor, payload) => {
      calls.push({ name: 'preview', actor, payload });
      return preview(payload);
    },
    createAlert: async (actor, payload) => {
      calls.push({ name: 'create', actor, payload });
      return { id: 7, name: 'Cheap steel' };
    },
  };

  await command.execute(subject, { apiService, sessions });

  assert.deepEqual(calls.map(({ name }) => name), ['preview']);
  assert.deepEqual(calls[0].payload, {
    name: 'Cheap steel',
    cooldown_minutes: 30,
    delivery_mode: 'daily',
    discord_enabled: true,
    type: 'market',
    resource: 'steel',
    direction: 'below',
    threshold: 3000,
    rearm_percent: 2,
  });
  assert.equal(subject.deferPayloads[0].ephemeral, true);
  assert.equal(embedJson(subject.edits[0]).title, 'Review Alert Before Saving');

  const confirmed = session(subject.edits[0], sessions, 1);
  const button = componentInteraction();
  await command.button(button, { apiService, sessions, session: confirmed });

  assert.deepEqual(calls.map(({ name }) => name), ['preview', 'create']);
  assert.equal(calls[1].actor.discordUserId, USER_ID);
  assert.deepEqual(calls[1].payload, calls[0].payload);
  assert.equal(embedJson(button.edits[0]).title, 'Alert Created');
});

test('nation watchlists use a multi-select and canonical event keys', async () => {
  const calls = [];
  const sessions = new InteractionSessionStore();
  const subject = commandInteraction('nation', { nation: 42, discord: true });
  const apiService = {
    baseUrl: 'https://nexus.example',
    previewAlert: async (actor, payload) => {
      calls.push({ actor, payload });
      return preview(payload);
    },
  };

  await command.execute(subject, { apiService, sessions });
  assert.equal(calls.length, 0);
  assert.equal(embedJson(subject.edits[0]).title, 'Choose Nation Events');
  const menu = subject.edits[0].components[0].toJSON().components[0];
  assert.equal(menu.max_values, 6);
  assert.doesNotMatch(JSON.stringify(menu.options), /assignment/);

  const selection = componentInteraction(['nation.alliance.changed', 'nation.city_count.changed']);
  await command.select(selection, { apiService, sessions, session: session(subject.edits[0], sessions) });

  assert.equal(selection.deferred, true);
  assert.deepEqual(calls[0].payload.events, ['nation.alliance.changed', 'nation.city_count.changed']);
  assert.equal(calls[0].payload.target_id, 42);
  assert.equal(embedJson(selection.edits[0]).title, 'Review Alert Before Saving');
});

test('unsaved marked tests show authoritative delivery outcomes and keep a save control', async () => {
  const sessions = new InteractionSessionStore();
  const subject = commandInteraction('market', {
    resource: 'food', direction: 'above', price: 250, discord: true,
  });
  const calls = [];
  const apiService = {
    baseUrl: 'https://nexus.example',
    previewAlert: async (_actor, payload) => preview(payload),
    testAlertDraft: async (actor, payload) => {
      calls.push({ actor, payload });
      return {
        success: true,
        queued: false,
        occurrence_id: 81,
        deliveries: [
          { id: 91, destination_kind: 'web', delivery_mode: 'immediate', status: 'delivered' },
          { id: 92, destination_kind: 'discord_dm', delivery_mode: 'immediate', status: 'undeliverable', reason_code: 'dm_closed' },
        ],
      };
    },
  };
  await command.execute(subject, { apiService, sessions });

  const testSession = session(subject.edits[0], sessions, 0);
  const button = componentInteraction();
  await command.button(button, { apiService, sessions, session: testSession });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor.discordUserId, USER_ID);
  assert.equal(embedJson(button.edits[0]).title, 'Alert Test Needs Attention');
  assert.match(JSON.stringify(embedJson(button.edits[0])), /Dm closed/i);
  assert.equal(button.edits[0].components[0].toJSON().components[0].label, 'Create alert');
});

test('settings reads are immediate while updates merge current state and wait for confirmation', async () => {
  const calls = [];
  const sessions = new InteractionSessionStore();
  const current = settings();
  const apiService = {
    getAlertSettings: async (actor) => {
      calls.push({ name: 'get', actor });
      return current;
    },
    updateAlertSettings: async (actor, payload) => {
      calls.push({ name: 'update', actor, payload });
      return settings({
        timezone: payload.timezone,
        quiet_hours: { enabled: true, start: payload.quiet_hours_start, end: payload.quiet_hours_end },
        default_digest: { time: payload.default_digest_time, weekday: payload.default_digest_weekday },
        discord_enabled: payload.discord_enabled,
      });
    },
  };

  const read = commandInteraction('settings');
  await command.execute(read, { apiService, sessions });
  assert.equal(embedJson(read.edits[0]).title, 'Alert Delivery Settings');
  assert.deepEqual(calls.map(({ name }) => name), ['get']);

  const update = commandInteraction('settings', {
    discord: true,
    timezone: 'America/Chicago',
    quiet_hours: true,
    quiet_start: '22:00',
    quiet_end: '07:00',
    digest_time: '08:30',
    digest_weekday: 5,
  });
  await command.execute(update, { apiService, sessions });
  assert.deepEqual(calls.map(({ name }) => name), ['get', 'get']);
  assert.equal(embedJson(update.edits[0]).title, 'Confirm Alert Settings');

  const confirmed = session(update.edits[0], sessions);
  const button = componentInteraction();
  await command.button(button, { apiService, sessions, session: confirmed });
  assert.deepEqual(calls.map(({ name }) => name), ['get', 'get', 'get', 'update']);
  assert.deepEqual(calls[3].payload, {
    timezone: 'America/Chicago',
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    default_digest_time: '08:30',
    default_digest_weekday: 5,
    discord_enabled: true,
  });
  assert.equal(embedJson(button.edits[0]).title, 'Alert Settings Updated');
});

test('activity is private, cursor-paged, and renders canonical outcomes', async () => {
  const calls = [];
  const sessions = new InteractionSessionStore();
  const apiService = {
    baseUrl: 'https://nexus.example',
    getAlertActivity: async (actor, params) => {
      calls.push({ actor, params });
      return params.before_delivery_id
        ? { items: [], next_cursor: null }
        : {
          items: [{
            activity_id: 101,
            event_key: 'market.price.crossed',
            event_label: 'Market price crossed',
            severity: 'normal',
            read_at: null,
            occurred_at: '2026-08-09T10:00:00Z',
            payload: { summary: 'Steel crossed below 3000' },
            deep_link_path: '/user/alerts',
            deliveries: [
              { destination_kind: 'web', status: 'delivered' },
              { destination_kind: 'discord_dm', status: 'queued' },
            ],
          }],
          next_cursor: 90,
        };
    },
  };
  const subject = commandInteraction('activity');
  await command.execute(subject, { apiService, sessions });

  assert.equal(subject.deferPayloads[0].ephemeral, true);
  assert.deepEqual(calls[0].params, { limit: 5 });
  assert.match(JSON.stringify(embedJson(subject.edits[0])), /Steel crossed below 3000/);

  const older = session(subject.edits[0], sessions);
  const button = componentInteraction();
  await command.button(button, { apiService, sessions, session: older });
  assert.deepEqual(calls[1].params, { limit: 5, before_delivery_id: 90 });
  assert.equal(embedJson(button.edits[0]).title, 'Alert Activity');
});

test('activity read-state mutations require confirmation and pass the explicit boolean', async () => {
  const calls = [];
  const sessions = new InteractionSessionStore();
  const apiService = {
    setAlertActivityRead: async (actor, deliveryId, read) => {
      calls.push({ actor, deliveryId, read });
      return { activity_id: deliveryId, read_at: null };
    },
  };
  const subject = commandInteraction('activity', { delivery: 55, action: 'unread' });
  await command.execute(subject, { apiService, sessions });

  assert.equal(calls.length, 0);
  assert.equal(embedJson(subject.edits[0]).title, 'Confirm Mark Unread');
  const confirmed = session(subject.edits[0], sessions);
  const button = componentInteraction();
  await command.button(button, { apiService, sessions, session: confirmed });

  assert.equal(calls[0].deliveryId, 55);
  assert.equal(calls[0].read, false);
  assert.equal(calls[0].actor.discordUserId, USER_ID);
  assert.equal(embedJson(button.edits[0]).title, 'Activity Marked Unread');
});

test('activity receipt reads expose normalized attempt state without mutation', async () => {
  const calls = [];
  const subject = commandInteraction('activity', { delivery: 72, action: 'details' });
  await command.execute(subject, {
    apiService: {
      getAlertDelivery: async (actor, id) => {
        calls.push({ actor, id });
        return {
          id,
          event_key: 'market.price.crossed',
          destination_kind: 'discord_dm',
          delivery_mode: 'immediate',
          status: 'failed',
          reason_code: 'network_error',
          batch: {
            id: 80,
            status: 'failed',
            attempt_count: 2,
            failure_code: 'network_error',
            last_attempt: { error_code: 'network_error' },
          },
        };
      },
    },
  });

  assert.equal(calls[0].actor.discordUserId, USER_ID);
  assert.equal(calls[0].id, 72);
  assert.equal(embedJson(subject.edits[0]).title, 'Alert Delivery #72');
  assert.match(JSON.stringify(embedJson(subject.edits[0])), /Network error/i);
});

test('market edits hydrate typed filters, preview first, and never parse condition text', async () => {
  const calls = [];
  const sessions = new InteractionSessionStore();
  const existing = {
    id: 12,
    name: 'Steel floor',
    type: 'market',
    condition: 'DO NOT PARSE THIS DISPLAY VALUE',
    filter: { resource: 'steel', direction: 'below', threshold: 3000 },
    cooldown_minutes: 60,
    rearm_percent: 1,
    expires_at: '2026-10-01T00:00:00Z',
    delivery: { mode: 'immediate', discord_enabled: false, timezone: 'UTC' },
  };
  const apiService = {
    baseUrl: 'https://nexus.example',
    getMyAlerts: async (actor) => {
      calls.push({ name: 'get', actor });
      return [existing];
    },
    previewAlert: async (actor, payload) => {
      calls.push({ name: 'preview', actor, payload });
      return preview(payload);
    },
    updateAlert: async (actor, id, payload) => {
      calls.push({ name: 'update', actor, id, payload });
      return { ...existing, ...payload, id };
    },
  };
  const subject = commandInteraction('edit', {
    id: 12, price: 2750, direction: 'above', discord: true, delivery: 'weekly', expires_days: 0,
  });
  await command.execute(subject, { apiService, sessions });

  assert.deepEqual(calls.map(({ name }) => name), ['get', 'preview']);
  assert.deepEqual(calls[1].payload, {
    type: 'market',
    name: 'Steel floor',
    cooldown_minutes: 60,
    delivery_mode: 'weekly',
    discord_enabled: true,
    rearm_percent: 1,
    expires_at: null,
    timezone: 'UTC',
    resource: 'steel',
    direction: 'above',
    threshold: 2750,
  });
  assert.equal(embedJson(subject.edits[0]).title, 'Review Changes to Alert #12');

  const confirmed = session(subject.edits[0], sessions, 1);
  const button = componentInteraction();
  await command.button(button, { apiService, sessions, session: confirmed });
  assert.deepEqual(calls.map(({ name }) => name), ['get', 'preview', 'get', 'update']);
  assert.equal(calls[3].id, 12);
  assert.deepEqual(calls[3].payload, calls[1].payload);
  assert.equal(embedJson(button.edits[0]).title, 'Alert Updated');
});

test('edit confirmation fails closed when the subscription changed after preview', async () => {
  const sessions = new InteractionSessionStore();
  let reads = 0;
  let updates = 0;
  const existing = {
    id: 12,
    name: 'Steel floor',
    type: 'market',
    filter: { resource: 'steel', direction: 'below', threshold: 3000 },
    cooldown_minutes: 60,
    rearm_percent: 1,
    expires_at: null,
    delivery: { mode: 'immediate', discord_enabled: false, timezone: 'UTC' },
  };
  const apiService = {
    getMyAlerts: async () => {
      reads += 1;
      return [{ ...existing, cooldown_minutes: reads === 1 ? 60 : 120 }];
    },
    previewAlert: async (_actor, payload) => preview(payload),
    updateAlert: async () => { updates += 1; },
  };
  const subject = commandInteraction('edit', { id: 12, discord: true });
  await command.execute(subject, { apiService, sessions });

  const button = componentInteraction();
  await command.button(button, { apiService, sessions, session: session(subject.edits[0], sessions, 1) });

  assert.equal(reads, 2);
  assert.equal(updates, 0);
  assert.equal(embedJson(button.edits[0]).title, 'Alert Action Failed');
  assert.match(embedJson(button.edits[0]).description, /changed after the preview/i);
});

test('manage mutations wait for confirmation and saved tests report receipt state', async () => {
  const calls = [];
  const sessions = new InteractionSessionStore();
  const apiService = {
    updateAlertStatus: async (actor, id, active) => calls.push({ name: 'status', actor, id, active }),
    testAlert: async (actor, id) => {
      calls.push({ name: 'test', actor, id });
      return {
        occurrence_id: 88,
        queued: true,
        deliveries: [
          { id: 99, destination_kind: 'discord_dm', delivery_mode: 'immediate', status: 'queued' },
        ],
      };
    },
  };

  const pause = commandInteraction('manage', { id: 9, action: 'pause' });
  await command.execute(pause, { apiService, sessions });
  assert.equal(calls.length, 0);
  assert.equal(embedJson(pause.edits[0]).title, 'Confirm Alert Pause');
  const pauseButton = componentInteraction();
  await command.button(pauseButton, { apiService, sessions, session: session(pause.edits[0], sessions) });
  assert.equal(calls[0].name, 'status');
  assert.equal(calls[0].active, false);

  const markedTest = commandInteraction('manage', { id: 10, action: 'test' });
  await command.execute(markedTest, { apiService, sessions });
  assert.equal(calls.length, 1);
  const testButton = componentInteraction();
  await command.button(testButton, { apiService, sessions, session: session(markedTest.edits[0], sessions) });
  assert.equal(calls[1].name, 'test');
  assert.equal(embedJson(testButton.edits[0]).title, 'Alert Test Queued');
  assert.doesNotMatch(embedJson(testButton.edits[0]).footer?.text ?? '', /check your discord/i);
});

test('watchlist private notification payload is accepted by the shared renderer', () => {
  assert.deepEqual(validatePrivateNotification({
    contract_version: 1,
    event_type: 'watchlist_triggered',
    recipient_discord_id: USER_ID,
    notification_id: 'watchlist-9-state',
    deep_link_path: '/user/alerts',
    subject: { type: 'alert_subscription', id: 9, label: 'Steel spike' },
    summary: { status: 'triggered', event: 'Steel crossed above 4000' },
  }), { valid: true });
});

test('watchlist private notification renders the trigger reason', async () => {
  let message;
  const queueCommand = {
    payload: {
      contract_version: 1,
      event_type: 'watchlist_triggered',
      recipient_discord_id: USER_ID,
      notification_id: 'watchlist-9-state',
      deep_link_path: '/user/alerts',
      subject: { type: 'alert_subscription', id: 9, label: 'Steel spike' },
      summary: { status: 'triggered', event: 'Steel crossed above 4000' },
    },
  };

  const result = await executePrivateNotification(queueCommand, {
    canContinue: () => true,
    resolveUser: async () => ({ id: USER_ID }),
    sendDirectMessage: async (_user, _command, _key, outgoing) => {
      message = outgoing;
      return { id: '456789012345678901' };
    },
    logger: { warn: () => {} },
  });

  assert.equal(result.success, true);
  assert.match(message.embeds[0].data.description, /Steel crossed above 4000/);
});
