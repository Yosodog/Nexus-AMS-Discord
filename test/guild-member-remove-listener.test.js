import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { registerGuildMemberRemoveListener } from '../src/listeners/guildMemberRemove.js';
import { createEventClient, createLogger } from './helpers.js';

test('member departures are reported only for the matching active connection', async () => {
  const client = createEventClient();
  const logger = createLogger();
  const reported = [];
  const connection = { guildId: '223456789012345678' };
  registerGuildMemberRemoveListener(client, logger, {
    connectionResolver: {
      resolve: ({ guildId }) => {
        if (guildId !== connection.guildId) throw new Error('foreign guild');
        return connection;
      },
    },
    applicationId: '123456789012345678',
    connectionServiceFactory: () => ({
      reportApplicationMemberDeparture: async (id) => reported.push(id),
    }),
  });

  const handler = client.handlers.get(Events.GuildMemberRemove);
  await handler({ id: '423456789012345678', guild: { id: connection.guildId } });
  await handler({ id: '523456789012345678', guild: { id: '999999999999999999' } });
  await handler({ id: 'invalid', guild: { id: connection.guildId } });

  assert.deepEqual(reported, ['423456789012345678']);
});
