import test from 'node:test';
import assert from 'node:assert/strict';
import {
  execute,
  validate,
} from '../src/services/queueActions/alertDelivery.js';
import {
  ALERT_RENDERER_MANIFEST,
  alertEventKeys,
  alertRendererRegistry,
} from '../src/services/queueActions/alertRendererRegistry.js';
import { createLogger } from './helpers.js';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '223456789012345678';
const USER_ID = '323456789012345678';
const ROLE_ID = '423456789012345678';

const basePayload = (overrides = {}) => ({
  contract_version: 1,
  delivery_id: 'delivery-1',
  occurrence_id: 'occurrence-1',
  event_key: 'nation.city_count.changed',
  schema_version: 1,
  template_key: 'member_alert_v1',
  destination: { type: 'channel', guild_id: GUILD_ID, channel_id: CHANNEL_ID },
  allowed_role_ids: [ROLE_ID],
  data: { subject_label: 'Nation 1', old_value: 10, new_value: 11 },
  occurred_at: '2026-08-08T12:00:00Z',
  observed_at: '2026-08-08T12:00:05Z',
  deep_link_path: '/alerts/activity/occurrence-1',
  is_test: false,
  severity: 'normal',
  priority: 50,
  ...overrides,
});

const runtimeFor = ({ send, sendDirectMessage, resolveUser, resolveChannel } = {}) => ({
  apiService: { baseUrl: 'https://nexus.example' },
  guildId: GUILD_ID,
  logger: createLogger(),
  canContinue: () => true,
  resolveUser: resolveUser ?? (async (id) => ({ id })),
  resolveChannel: resolveChannel ?? (async () => ({
    guildId: GUILD_ID,
    isTextBased: () => true,
  })),
  send: send ?? (async () => ({ id: 'provider-message-1', guildId: GUILD_ID, channelId: CHANNEL_ID })),
  sendDirectMessage: sendDirectMessage ?? (async () => ({ id: 'provider-dm-1', guildId: null, channelId: '523456789012345678' })),
});

test('ALERT_DELIVERY_V1 delivers a channel alert with the canonical receipt and allowlisted roles', async () => {
  let message;
  const result = await execute({ id: 'queue-1', payload: basePayload() }, runtimeFor({
    send: async (_target, _command, _step, outgoing) => {
      message = outgoing;
      return { id: 'provider-message-1', guildId: GUILD_ID, channelId: CHANNEL_ID };
    },
  }));

  assert.equal(result.success, true);
  assert.deepEqual(result.result, {
    success: true,
    delivery_id: 'delivery-1',
    delivery: 'delivered',
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    provider_message_id: 'provider-message-1',
    error_code: null,
    retryable: false,
  });
  assert.deepEqual(message.allowedMentions, {
    parse: [],
    users: [],
    roles: [ROLE_ID],
    repliedUser: false,
  });
});

test('ALERT_DELIVERY_V1 maps a closed DM to terminal undeliverable with no public fallback', async () => {
  let publicFallbackUsed = false;
  const payload = basePayload({
    delivery_id: 'delivery-dm-closed',
    destination: { type: 'dm', discord_user_id: USER_ID },
    allowed_role_ids: [],
  });
  const result = await execute({ id: 'queue-dm-closed', payload }, runtimeFor({
    resolveChannel: async () => {
      publicFallbackUsed = true;
      throw new Error('DMs must never fall back to a public channel');
    },
    sendDirectMessage: async () => {
      const error = new Error('Cannot send messages to this user');
      error.code = 50007;
      throw error;
    },
  }));

  assert.equal(result.success, true);
  assert.deepEqual(result.result, {
    success: false,
    delivery_id: 'delivery-dm-closed',
    delivery: 'undeliverable',
    guild_id: null,
    channel_id: null,
    provider_message_id: null,
    error_code: 'dm_closed',
    retryable: false,
  });
  assert.equal(publicFallbackUsed, false);
});

test('ALERT_DELIVERY_V1 maps rate limits to retryable failed delivery with retry_after_ms', async () => {
  const result = await execute({ id: 'queue-rate-limit', payload: basePayload({ delivery_id: 'delivery-rate-limit' }) }, runtimeFor({
    send: async () => {
      const error = new Error('rate limited');
      error.status = 429;
      error.retry_after = 1.25;
      throw error;
    },
  }));

  assert.equal(result.success, false);
  assert.deepEqual(result.result, {
    success: false,
    delivery_id: 'delivery-rate-limit',
    delivery: 'failed',
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    provider_message_id: null,
    error_code: 'rate_limited',
    retryable: true,
    retry_after_ms: 1250,
  });
});

test('ALERT_DELIVERY_V1 quarantines invalid payloads', async () => {
  const result = await execute({
    id: 'queue-invalid',
    payload: basePayload({ delivery_id: 'delivery-invalid', schema_version: 2 }),
  }, runtimeFor());

  assert.deepEqual(result, {
    success: true,
    result: {
      success: false,
      delivery_id: 'delivery-invalid',
      delivery: 'quarantined',
      guild_id: null,
      channel_id: null,
      provider_message_id: null,
      error_code: 'unsupported_alert_schema_version',
      retryable: false,
    },
  });
});

test('ALERT_DELIVERY_V1 accepts code-owned event payload fields emitted by Nexus', () => {
  assert.deepEqual(validate(basePayload({
    event_key: 'milcom.incident.detected',
    template_key: 'milcom_alert_v1',
    data: {
      incident_id: 91,
      war_id: 701,
      attacked_nation_id: 11,
      aggressor_nation_id: 12,
      label: 'Incoming war against Test Nation',
    },
  })), { valid: true });

  assert.deepEqual(validate(basePayload({
    event_key: 'alliance.membership.changed',
    template_key: 'member_alert_v1',
    data: {
      label: 'Membership changed',
      added: ['Nation One', 'Nation Two'],
      removed: ['Nation Three'],
    },
  })), { valid: true });
});

test('digest.v1 accepts at most 20 items', () => {
  const item = (index) => ({
    title: `Alert ${index}`,
    description: 'A safe alert summary',
    event_key: 'nation.city_count.changed',
    occurred_at: '2026-08-08T12:00:00Z',
    deep_link_path: `/alerts/activity/${index}`,
  });
  const digest = (count) => basePayload({
    template_key: 'digest.v1',
    event_key: 'nation.city_count.changed',
    data: { title: 'Daily alerts', items: Array.from({ length: count }, (_, index) => item(index)) },
  });

  assert.deepEqual(validate(digest(20)), { valid: true });
  assert.deepEqual(validate(digest(21)), { valid: false, reason: 'invalid_template_data' });
});

test('renderer manifest matches the canonical local registry', () => {
  assert.deepEqual(alertRendererRegistry.verifyManifest(ALERT_RENDERER_MANIFEST), {
    valid: true,
    contract_version: 1,
  });

  const missingTemplate = {
    ...ALERT_RENDERER_MANIFEST,
    templates: ALERT_RENDERER_MANIFEST.templates.slice(0, -1),
  };
  assert.equal(alertRendererRegistry.verifyManifest(missingTemplate).reason, 'alert_manifest_mismatch');
});

test('alert catalog and manifest contain no proactive war or spy assignment events', () => {
  const serialized = JSON.stringify(ALERT_RENDERER_MANIFEST);
  assert.equal(alertEventKeys.some((eventKey) => /(?:war|spy).*assignment/i.test(eventKey)), false);
  assert.equal(serialized.includes('war_assignment'), false);
  assert.equal(serialized.includes('spy_assignment'), false);
  assert.equal(serialized.includes('war.assignment'), false);
  assert.equal(serialized.includes('spy.assignment'), false);
  assert.deepEqual(validate(basePayload({ event_key: 'war_assignment.created' })), {
    valid: false,
    reason: 'invalid_event_key',
  });
  const assignmentManifest = {
    ...ALERT_RENDERER_MANIFEST,
    templates: ALERT_RENDERER_MANIFEST.templates.map((template, index) => index === 0
      ? { ...template, event_keys: [...template.event_keys, 'spy_assignment.created'] }
      : template),
  };
  assert.deepEqual(alertRendererRegistry.verifyManifest(assignmentManifest), {
    valid: false,
    reason: 'assignment_events_not_supported',
  });
});
