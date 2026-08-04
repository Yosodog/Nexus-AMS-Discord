import test from 'node:test';
import assert from 'node:assert/strict';
import { queueActions } from '../src/services/queueActions/index.js';
import { QueueActionRuntime, extractUserSnowflakes } from '../src/services/queueActions/runtime.js';
import {
  formatDiscordTime,
  formatNumber,
  parseDate,
} from '../src/services/queueActions/support.js';
import { createLogger } from './helpers.js';

const CHANNEL_ID = '123456789012345678';
const USER_ID = '223456789012345678';

test('every registered queue action exposes validate and execute boundaries', () => {
  assert.deepEqual(Object.keys(queueActions).sort(), [
    'ALLIANCE_DEPARTURE',
    'ALLIANCE_ROLE_REMOVAL',
    'BEIGE_ALERT',
    'BLOCKADE_RELIEF_NOTIFICATION',
    'CITY_TIER_SYNC',
    'INACTIVITY_ALERT',
    'PRIVATE_NOTIFICATION',
    'WAR_ALERT',
    'WAR_ROOM_ARCHIVE',
    'WAR_ROOM_CREATE',
  ]);
  for (const action of Object.values(queueActions)) {
    assert.equal(typeof action.validate, 'function');
    assert.equal(typeof action.execute, 'function');
  }
});

test('PRIVATE_NOTIFICATION accepts only versioned structured events and reports DM delivery outcomes', async () => {
  const action = queueActions.PRIVATE_NOTIFICATION;
  const payload = {
    contract_version: 1,
    recipient_discord_id: USER_ID,
    event_type: 'loan_approved',
    notification_id: 'loan-42-approved',
    subject: { type: 'loan', id: 42, label: 'Loan 42' },
    occurred_at: '2026-07-10T12:00:00Z',
    deep_link_path: '/loans',
    summary: { status: 'approved' },
  };
  assert.deepEqual(action.validate(payload), { valid: true });
  assert.deepEqual(action.validate({ ...payload, message: 'backend-controlled text' }), {
    valid: false,
    reason: 'unsafe_notification_payload',
  });
  assert.deepEqual(action.validate({ ...payload, event_type: 'arbitrary' }), {
    valid: false,
    reason: 'invalid_event_type',
  });

  let sentPayload;
  const runtime = {
    logger: createLogger(),
    canContinue: () => true,
    resolveUser: async (id) => ({ id }),
    sendDirectMessage: async (_user, _command, _step, message) => {
      sentPayload = message;
      return { id: 'dm-1' };
    },
  };
  const delivered = await action.execute({ id: 'queue-dm', payload }, runtime);
  assert.deepEqual(delivered, {
    success: true,
    result: { delivery: 'delivered', discord_message_id: 'dm-1' },
  });
  assert.deepEqual(sentPayload.allowedMentions, { parse: [], repliedUser: false });

  runtime.resolveUser = async () => null;
  assert.deepEqual(await action.execute({ id: 'queue-dm-2', payload }, runtime), {
    success: true,
    result: { delivery: 'undeliverable', reason: 'user_unavailable' },
  });
});

test('PRIVATE_NOTIFICATION renders useful audit counts, details, tone, timestamp, and link', async () => {
  const action = queueActions.PRIVATE_NOTIFICATION;
  const payload = {
    contract_version: 1,
    recipient_discord_id: USER_ID,
    event_type: 'audit_summary_reminder',
    notification_id: 'audit-summary-42',
    subject: { type: 'audit_summary', id: 42, label: 'Audit findings' },
    occurred_at: '2026-07-10T12:00:00Z',
    deep_link_path: '/audit',
    summary: {
      status: 'needs_attention',
      finding_count: 3,
      overdue_count: 1,
      finding_name: 'Warchest below requirement',
    },
  };
  let message;
  await action.execute({ id: 'queue-audit', payload }, {
    apiService: { baseUrl: 'https://nexus.example' },
    logger: createLogger(),
    canContinue: () => true,
    resolveUser: async (id) => ({ id }),
    sendDirectMessage: async (_user, _command, _step, outgoing) => {
      message = outgoing;
      return { id: 'dm-audit' };
    },
  });

  const embed = message.embeds[0].toJSON();
  assert.equal(embed.title, 'Audit Findings Need Attention');
  assert.equal(embed.url, 'https://nexus.example/audit');
  assert.equal(embed.color, 0xed4245);
  assert.match(embed.description, /3 active audit findings need attention/);
  assert.match(embed.description, /Warchest below requirement/);
  assert.match(embed.description, /Overdue:\*\* 1/);
  assert.match(embed.description, /Review audit findings in Nexus/);
  assert.equal(embed.timestamp, '2026-07-10T12:00:00.000Z');
  assert.equal(embed.footer, undefined);
});

test('channel alert action validators distinguish absent, malformed, and valid targets', () => {
  for (const name of ['WAR_ALERT', 'ALLIANCE_DEPARTURE', 'INACTIVITY_ALERT']) {
    assert.deepEqual(queueActions[name].validate(null), { valid: false, reason: 'invalid_payload' });
    assert.deepEqual(queueActions[name].validate({}), { valid: false, reason: 'missing_channel' });
    assert.deepEqual(queueActions[name].validate({ channel_id: 'not-a-snowflake' }), {
      valid: false,
      reason: 'invalid_channel',
    });
    assert.deepEqual(queueActions[name].validate({ channel_id: 123456789012345678 }), {
      valid: false,
      reason: 'invalid_channel',
    });
    assert.deepEqual(queueActions[name].validate({ channel_id: CHANNEL_ID }), { valid: true });
  }
});

test('BEIGE_ALERT validates its channel and requires a non-empty supported nation shape', () => {
  const validate = queueActions.BEIGE_ALERT.validate;
  assert.deepEqual(validate(null), { valid: false, reason: 'invalid_payload' });
  assert.deepEqual(validate({}), { valid: false, reason: 'missing_channel' });
  assert.deepEqual(validate({ channel_id: 'bad', nation: {} }), { valid: false, reason: 'invalid_channel' });
  assert.deepEqual(validate({ channel_id: CHANNEL_ID }), { valid: false, reason: 'invalid_payload' });
  assert.deepEqual(validate({ channel_id: CHANNEL_ID, nations: [] }), { valid: false, reason: 'invalid_payload' });
  assert.deepEqual(validate({ channel_id: CHANNEL_ID, nation: {} }), { valid: true });
  assert.deepEqual(validate({ channel_id: CHANNEL_ID, nations: [{}] }), { valid: true });
});

test('ALLIANCE_ROLE_REMOVAL accepts only a Discord member snowflake', () => {
  const validate = queueActions.ALLIANCE_ROLE_REMOVAL.validate;
  assert.deepEqual(validate(null), { valid: false, reason: 'invalid_payload' });
  assert.deepEqual(validate({}), { valid: false, reason: 'missing_discord_id' });
  assert.deepEqual(validate({ discord_id: 'member' }), { valid: false, reason: 'invalid_discord_id' });
  assert.deepEqual(validate({ discord_id: 223456789012345678 }), {
    valid: false,
    reason: 'invalid_discord_id',
  });
  assert.deepEqual(validate({ discord_id: USER_ID }), { valid: true });
});

test('WAR_ROOM_CREATE validates forum, role, source, and assignment boundaries', () => {
  const validate = queueActions.WAR_ROOM_CREATE.validate;
  assert.deepEqual(validate(null), { valid: false, reason: 'invalid_payload' });
  assert.deepEqual(validate({}), { valid: false, reason: 'missing_channel' });
  assert.deepEqual(validate({ forum_channel_id: 'bad' }), { valid: false, reason: 'invalid_channel' });
  assert.deepEqual(validate({ forum_channel_id: 123456789012345678 }), {
    valid: false,
    reason: 'invalid_channel',
  });
  assert.deepEqual(validate({ forum_channel_id: CHANNEL_ID, defense_role_id: 'bad' }), {
    valid: false,
    reason: 'invalid_role',
  });
  assert.deepEqual(validate({ forum_channel_id: CHANNEL_ID, defense_role_id: 0 }), {
    valid: false,
    reason: 'invalid_role',
  });
  assert.deepEqual(validate({ forum_channel_id: CHANNEL_ID, source: 'counter' }), {
    valid: false,
    reason: 'invalid_source',
  });
  assert.deepEqual(validate({ forum_channel_id: CHANNEL_ID, source: { type: 'war_counter', id: 0 } }), {
    valid: false,
    reason: 'invalid_source_id',
  });
  const milcomSource = {
    type: 'milcom_objective',
    id: 10,
    operation_id: 20,
    operation_type: 'plan',
    name: 'Coalition Dawn',
    url: 'https://nexus.example/admin/milcom/plans/10',
  };
  assert.deepEqual(validate({
    forum_channel_id: CHANNEL_ID,
    source: { type: 'milcom_objective', id: 10 },
  }), { valid: false, reason: 'invalid_operation_id' });
  assert.deepEqual(validate({
    forum_channel_id: CHANNEL_ID,
    source: { type: 'milcom_objective', id: 10, operation_id: 20 },
  }), { valid: false, reason: 'invalid_operation_type' });
  assert.deepEqual(validate({
    forum_channel_id: CHANNEL_ID,
    source: { type: 'milcom_objective', id: 10, operation_id: 20, operation_type: 'plan' },
  }), { valid: false, reason: 'invalid_operation_name' });
  assert.deepEqual(validate({
    forum_channel_id: CHANNEL_ID,
    source: { ...milcomSource, url: 'javascript:alert(1)' },
    dispatch_id: 30,
  }), { valid: false, reason: 'invalid_source_url' });
  assert.deepEqual(validate({ forum_channel_id: CHANNEL_ID, source: milcomSource }), {
    valid: false,
    reason: 'invalid_dispatch_id',
  });
  assert.deepEqual(validate({
    forum_channel_id: CHANNEL_ID,
    source: milcomSource,
    dispatch_id: 30,
    forum_tag_ids: [USER_ID, USER_ID],
  }), { valid: false, reason: 'invalid_forum_tags' });
  assert.deepEqual(validate({
    forum_channel_id: CHANNEL_ID,
    source: milcomSource,
    dispatch_id: 30,
    forum_tag_ids: Array.from({ length: 6 }, (_, index) => `${50_000_000_000_000_000n + BigInt(index)}`),
  }), { valid: false, reason: 'invalid_forum_tags' });
  assert.deepEqual(validate({ forum_channel_id: CHANNEL_ID, assigned_members: {} }), {
    valid: false,
    reason: 'invalid_assigned_members',
  });
  assert.deepEqual(validate({ forum_channel_id: CHANNEL_ID, room_name_suggestion: 'x'.repeat(101) }), {
    valid: false,
    reason: 'invalid_room_name',
  });
  assert.deepEqual(validate({ forum_channel_id: CHANNEL_ID, reason: 'x'.repeat(1001) }), {
    valid: false,
    reason: 'invalid_reason',
  });
  assert.deepEqual(validate({
    forum_channel_id: CHANNEL_ID,
    defense_role_id: USER_ID,
    source: { type: 'war_counter', id: 1 },
    assigned_members: [],
  }), { valid: true });
  assert.deepEqual(validate({
    forum_channel_id: CHANNEL_ID,
    source: milcomSource,
    dispatch_id: 30,
    assigned_members: [],
    forum_tag_ids: [USER_ID],
  }), { valid: true });
});

test('WAR_ROOM_ARCHIVE validates persisted counter and direct channel targets', () => {
  const validate = queueActions.WAR_ROOM_ARCHIVE.validate;
  assert.deepEqual(validate(null), { valid: false, reason: 'invalid_payload' });
  assert.deepEqual(validate({ source: { type: 'war_counter' } }), { valid: false, reason: 'invalid_source_id' });
  assert.deepEqual(validate({ source: { type: 'war_counter', id: 7 } }), { valid: true });
  assert.deepEqual(validate({ source: { type: 'milcom_objective' } }), {
    valid: false,
    reason: 'invalid_source_id',
  });
  assert.deepEqual(validate({ source: { type: 'milcom_objective', id: 8 } }), { valid: true });
  assert.deepEqual(validate({
    source: { type: 'milcom_objective', id: 8 },
    discord_channel_id: 'bad',
  }), { valid: false, reason: 'invalid_channel' });
  assert.deepEqual(validate({}), { valid: false, reason: 'missing_channel' });
  assert.deepEqual(validate({ discord_channel_id: 'bad' }), { valid: false, reason: 'invalid_channel' });
  assert.deepEqual(validate({ discord_channel_id: 123456789012345678 }), {
    valid: false,
    reason: 'invalid_channel',
  });
  assert.deepEqual(validate({ discord_channel_id: CHANNEL_ID, archive: false }), {
    valid: false,
    reason: 'invalid_archive_options',
  });
  assert.deepEqual(validate({
    discord_channel_id: CHANNEL_ID,
    archive: { title_prefix: 'x'.repeat(101) },
  }), { valid: false, reason: 'invalid_title_prefix' });
  assert.deepEqual(validate({ discord_channel_id: CHANNEL_ID, archive: { title_prefix: '' } }), {
    valid: true,
  });
  assert.deepEqual(validate({ discord_channel_id: CHANNEL_ID, archive: { lock: true } }), { valid: true });
});

test('QueueActionRuntime creates deterministic nonce-safe messages and strict mention allowlists', () => {
  const runtime = new QueueActionRuntime({
    client: { channels: { cache: new Map() }, guilds: { cache: new Map() } },
    logger: createLogger(),
    guildId: CHANNEL_ID,
  });
  const first = runtime.messagePayload({ id: 'queue-1' }, 'step-1', { content: '@everyone' });
  const repeated = runtime.messagePayload({ id: 'queue-1' }, 'step-1', { content: '@everyone' });
  const next = runtime.messagePayload({ id: 'queue-1' }, 'step-2', { content: 'next' });

  assert.equal(first.nonce, repeated.nonce);
  assert.notEqual(first.nonce, next.nonce);
  assert.equal(first.nonce.length <= 25, true);
  assert.equal(first.enforceNonce, true);
  assert.deepEqual(first.allowedMentions, { parse: [], repliedUser: false });
  assert.deepEqual(
    extractUserSnowflakes(`<@${USER_ID}> <@${USER_ID}> <@invalid>`),
    [USER_ID],
  );
});

test('QueueActionRuntime resolves only configured-guild channels across cache and fetch paths', async () => {
  const logger = createLogger();
  const cached = { guildId: CHANNEL_ID, isTextBased: () => true };
  const fetched = { guildId: CHANNEL_ID, isTextBased: () => true };
  const foreign = { guildId: '999999999999999999', isTextBased: () => true };
  const client = {
    channels: {
      cache: new Map([
        ['323456789012345678', cached],
        ['423456789012345678', foreign],
      ]),
      fetch: async (id) => {
        if (id === '523456789012345678') return fetched;
        if (id === '623456789012345678') return foreign;
        throw new Error('missing');
      },
    },
    guilds: { cache: new Map(), fetch: async () => null },
  };
  const runtime = new QueueActionRuntime({ client, logger, guildId: CHANNEL_ID });

  assert.equal(await runtime.resolveTextChannel('323456789012345678'), cached);
  assert.equal(await runtime.resolveTextChannel('523456789012345678'), fetched);
  assert.equal(await runtime.resolveTextChannel('623456789012345678'), null);
  assert.equal(await runtime.resolveTextChannel('723456789012345678'), null);
  assert.equal(await runtime.resolveTextChannel(323456789012345678), null);
  assert.equal(await runtime.resolveChannel('323456789012345678'), cached);
  assert.equal(await runtime.resolveChannel('523456789012345678'), fetched);
  assert.equal(logger.entries.warn.length >= 1, true);
});

test('QueueActionRuntime resolves cached/fetched guilds and exposes lease continuation state', async () => {
  const cachedGuild = { id: CHANNEL_ID };
  const cachedRuntime = new QueueActionRuntime({
    client: {
      channels: { cache: new Map() },
      guilds: { cache: new Map([[CHANNEL_ID, cachedGuild]]), fetch: async () => null },
    },
    logger: createLogger(),
    guildId: CHANNEL_ID,
  });
  assert.equal(await cachedRuntime.resolveGuild(), cachedGuild);
  assert.equal(cachedRuntime.forExecution({ canContinue: () => false }).canContinue(), false);
  assert.equal(cachedRuntime.forExecution().canContinue(), true);

  const fetchedGuild = { id: CHANNEL_ID };
  const fetchedRuntime = new QueueActionRuntime({
    client: {
      channels: { cache: new Map() },
      guilds: { cache: new Map(), fetch: async () => fetchedGuild },
    },
    logger: createLogger(),
    guildId: CHANNEL_ID,
  });
  assert.equal(await fetchedRuntime.resolveGuild(), fetchedGuild);

  const failedLogger = createLogger();
  const failedRuntime = new QueueActionRuntime({
    client: {
      channels: { cache: new Map() },
      guilds: { cache: new Map(), fetch: async () => { throw new Error('missing'); } },
    },
    logger: failedLogger,
    guildId: CHANNEL_ID,
  });
  assert.equal(await failedRuntime.resolveGuild(), null);
  assert.equal(failedLogger.entries.warn.length, 1);
});

test('queue action support safely parses and formats Discord content', () => {
  const date = parseDate('2026-07-10T00:00:00Z');
  assert.equal(date instanceof Date, true);
  assert.equal(parseDate('not-a-date'), null);
  assert.equal(formatDiscordTime(date, 'R').startsWith('<t:'), true);
  assert.equal(formatDiscordTime(null), 'Unknown');
  assert.equal(formatNumber(1234), '1,234');
  assert.equal(formatNumber('not-a-number'), '—');
});
