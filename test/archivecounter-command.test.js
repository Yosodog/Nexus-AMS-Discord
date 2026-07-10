import test from 'node:test';
import assert from 'node:assert/strict';
import { execute as executeArchivecounter } from '../src/commands/archivecounter.js';
import { createLogger, embedJson } from './helpers.js';

const GUILD_ID = '123456789012345678';
const THREAD_ID = '223456789012345678';
const MODERATOR_ID = '323456789012345678';

function createInteraction(thread) {
  const interaction = {
    guildId: GUILD_ID,
    guild: { id: GUILD_ID },
    channelId: '423456789012345678',
    channel: { isThread: () => true },
    client: {
      channels: {
        cache: new Map(thread ? [[thread.id, thread]] : []),
        fetch: async () => null,
      },
    },
    user: { id: MODERATOR_ID },
    options: { getInteger: () => 42 },
    replies: [],
    edits: [],
    deferReply: async () => {},
    reply: async (payload) => interaction.replies.push(payload),
    editReply: async (payload) => interaction.edits.push(payload),
  };
  return interaction;
}

test('/archivecounter archives only the channel persisted on the Nexus counter', async () => {
  const operations = [];
  const thread = {
    id: THREAD_ID,
    guildId: GUILD_ID,
    name: 'counter-room',
    archived: false,
    locked: false,
    isThread: () => true,
    setName: async () => operations.push('name'),
    setArchived: async () => operations.push('archive'),
    setLocked: async () => operations.push('lock'),
  };
  const interaction = createInteraction(thread);
  const apiService = {
    archiveWarCounter: async () => ({ counter: { id: 42, discord_channel_id: THREAD_ID } }),
  };

  await executeArchivecounter(interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  assert.deepEqual(operations, ['name', 'archive', 'lock']);
  assert.match(embedJson(interaction.edits[0]).description, /Discord thread archived/i);
});

test('/archivecounter never falls back to the current thread when Nexus has no channel', async () => {
  const interaction = createInteraction(null);
  const apiService = {
    archiveWarCounter: async () => ({ counter: { id: 42, discord_channel_id: null } }),
  };

  await executeArchivecounter(interaction, { logger: createLogger(), apiService, guildId: GUILD_ID });

  const description = embedJson(interaction.edits[0]).description;
  assert.match(description, /archived in Nexus/i);
  assert.match(description, /could not be completed automatically/i);
});
