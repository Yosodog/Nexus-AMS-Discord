import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
  buildApplicationChannelTopic,
  cleanupApplicationInterviewChannel,
  parseApplicationChannelIdentity,
  validateApplicationInterviewChannel,
} from '../src/utils/applicationChannels.js';
import { createLogger } from './helpers.js';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '223456789012345678';
const application = {
  id: 42,
  nation_id: 9001,
  discord_channel_id: CHANNEL_ID,
};

function createChannel(overrides = {}) {
  return {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    type: ChannelType.GuildText,
    name: 'app-42-9001-test-leader',
    topic: buildApplicationChannelTopic(42, 9001),
    delete: async () => {},
    ...overrides,
  };
}

test('application channel identity requires an exact topic or exact anchored legacy name', () => {
  assert.deepEqual(parseApplicationChannelIdentity(createChannel()), {
    applicationId: 42,
    nationId: 9001,
    source: 'topic',
  });
  assert.deepEqual(parseApplicationChannelIdentity(createChannel({ topic: null })), {
    applicationId: 42,
    nationId: 9001,
    source: 'legacy_name',
  });
  assert.equal(parseApplicationChannelIdentity(createChannel({ topic: null, name: 'app-42-9001-test-renamed!' })), null);
  assert.equal(parseApplicationChannelIdentity(createChannel({ topic: 'nexus-application:42;nation:9001 extra' })), null);
});

test('cleanup deletes a verified authoritative application channel', async () => {
  let deletedReason = null;
  const channel = createChannel({
    delete: async (reason) => {
      deletedReason = reason;
    },
  });
  const guild = {
    id: GUILD_ID,
    channels: { fetch: async (id) => (id === CHANNEL_ID ? channel : null) },
  };

  const result = await cleanupApplicationInterviewChannel({
    guild,
    guildId: GUILD_ID,
    application,
    logger: createLogger(),
    reason: 'approved',
  });

  assert.deepEqual(result, {
    success: true,
    channelId: CHANNEL_ID,
    identitySource: 'topic',
  });
  assert.equal(deletedReason, 'approved');
});

test('cleanup never searches for a fallback when Nexus has no channel id', async () => {
  const guild = {
    id: GUILD_ID,
    channels: {
      cache: new Map([[CHANNEL_ID, createChannel()]]),
      fetch: async () => assert.fail('missing authoritative id must not trigger a fetch'),
    },
  };

  const result = await cleanupApplicationInterviewChannel({
    guild,
    guildId: GUILD_ID,
    application: { ...application, discord_channel_id: null },
    logger: createLogger(),
  });

  assert.deepEqual(result, { success: false, reason: 'missing_channel' });
});

test('application channel validation rejects stale, wrong-type, foreign-guild, and mismatched targets', () => {
  const cases = [
    [createChannel({ type: ChannelType.GuildVoice }), 'wrong_channel_type'],
    [createChannel({ guildId: '323456789012345678' }), 'wrong_guild'],
    [createChannel({ topic: buildApplicationChannelTopic(43, 9001) }), 'application_mismatch'],
    [createChannel({ topic: null, name: 'app-42-9002-test-leader' }), 'application_mismatch'],
    [createChannel({ topic: null, name: 'renamed-interview' }), 'application_mismatch'],
  ];

  for (const [channel, reason] of cases) {
    assert.deepEqual(
      validateApplicationInterviewChannel({ channel, application, guildId: GUILD_ID }),
      { valid: false, reason },
    );
  }
});

test('cleanup reports an unavailable authoritative channel without mutating cached candidates', async () => {
  let cachedDeleted = false;
  const guild = {
    id: GUILD_ID,
    channels: {
      cache: new Map([[CHANNEL_ID, createChannel({ delete: async () => { cachedDeleted = true; } })]]),
      fetch: async () => {
        throw new Error('Unknown Channel');
      },
    },
  };

  const result = await cleanupApplicationInterviewChannel({
    guild,
    guildId: GUILD_ID,
    application,
    logger: createLogger(),
  });

  assert.deepEqual(result, { success: false, reason: 'channel_unavailable', channelId: CHANNEL_ID });
  assert.equal(cachedDeleted, false);
});

test('cleanup deletes only the authoritative id when duplicate exact matches exist', async () => {
  let authoritativeDeleted = false;
  let duplicateDeleted = false;
  const authoritative = createChannel({
    id: CHANNEL_ID,
    delete: async () => { authoritativeDeleted = true; },
  });
  const duplicateId = '323456789012345678';
  const duplicate = createChannel({
    id: duplicateId,
    delete: async () => { duplicateDeleted = true; },
  });
  const guild = {
    id: GUILD_ID,
    channels: {
      cache: new Map([[duplicateId, duplicate]]),
      fetch: async (id) => (id === CHANNEL_ID ? authoritative : null),
    },
  };

  const result = await cleanupApplicationInterviewChannel({
    guild,
    guildId: GUILD_ID,
    application,
    logger: createLogger(),
    reason: 'approved',
  });

  assert.equal(result.success, true);
  assert.equal(authoritativeDeleted, true);
  assert.equal(duplicateDeleted, false);
});
