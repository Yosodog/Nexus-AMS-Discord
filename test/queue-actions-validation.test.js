import test from 'node:test';
import assert from 'node:assert/strict';
import { queueActions } from '../src/services/queueActions/index.js';
import { QueueActionRuntime, extractUserSnowflakes } from '../src/services/queueActions/runtime.js';
import {
  chunkDiscordMessage,
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
    'INACTIVITY_ALERT',
    'WAR_ALERT',
    'WAR_ROOM_ARCHIVE',
    'WAR_ROOM_CREATE',
  ]);
  for (const action of Object.values(queueActions)) {
    assert.equal(typeof action.validate, 'function');
    assert.equal(typeof action.execute, 'function');
  }
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
});

test('WAR_ROOM_ARCHIVE validates persisted counter and direct channel targets', () => {
  const validate = queueActions.WAR_ROOM_ARCHIVE.validate;
  assert.deepEqual(validate(null), { valid: false, reason: 'invalid_payload' });
  assert.deepEqual(validate({ source: { type: 'war_counter' } }), { valid: false, reason: 'invalid_source_id' });
  assert.deepEqual(validate({ source: { type: 'war_counter', id: 7 } }), { valid: true });
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

test('queue action support safely parses, formats, and chunks Discord content', () => {
  const date = parseDate('2026-07-10T00:00:00Z');
  assert.equal(date instanceof Date, true);
  assert.equal(parseDate('not-a-date'), null);
  assert.equal(formatDiscordTime(date, 'R').startsWith('<t:'), true);
  assert.equal(formatDiscordTime(null), 'Unknown');
  assert.equal(formatNumber(1234), '1,234');
  assert.equal(formatNumber('not-a-number'), '—');
  assert.deepEqual(chunkDiscordMessage('short', 10), ['short']);
  assert.deepEqual(chunkDiscordMessage('first\nsecond', 6), ['first', 'second']);
  assert.deepEqual(chunkDiscordMessage('abcdefgh', 3), ['abc', 'def', 'gh']);
});
