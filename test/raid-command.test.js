import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/commands/raid.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { embedJson } from './helpers.js';

const target = (id) => ({
  nation_id: id,
  nation_name: `Nation ${id}`,
  leader_name: `Leader ${id}`,
  alliance_id: 50,
  alliance_name: 'Alliance Fifty',
  cities: 40,
  score: 9000 + id,
  estimated_value: 42000000 + id,
  last_beige_value: 39000000 + id,
  last_active: '2026-07-19T12:00:00Z',
  defensive_wars: 1,
  military: { soldiers: 100000, tanks: 5000, aircraft: 1800, ships: 60 },
  nation_url: `https://politicsandwar.com/nation/id=${id}`,
  alliance_url: 'https://politicsandwar.com/alliance/id=50',
});

test('/raid defaults to ten results and returns a rich paginated target list', async () => {
  let filters = null;
  let reply = null;
  const interaction = {
    id: '345678901234567890',
    guildId: '123456789012345678',
    user: { id: '234567890123456789' },
    options: {
      getInteger: () => null,
      getString: () => null,
    },
    deferReply: async () => {},
    editReply: async (payload) => { reply = payload; },
  };
  let sequence = 0;
  const sessions = new InteractionSessionStore({
    createToken: () => `raid${String(sequence += 1).padStart(28, '0')}`,
  });
  const apiService = {
    baseUrl: 'https://nexus.example',
    getMyRaidAssignments: async (_actor, value) => {
      filters = value;
      return [1, 2, 3, 4].map(target);
    },
  };

  await execute(interaction, { apiService, sessions });

  assert.deepEqual(filters, { nation_id: undefined, sort: 'value', limit: 10 });
  assert.ok(reply);
  const embed = embedJson(reply);
  assert.equal(embed.fields.length, 2);
  assert.match(embed.fields[0].name, /Nation 1/);
  assert.match(embed.fields[0].name, /Leader 1/);
  assert.match(embed.fields[0].value, /Alliance Fifty/);
  assert.match(embed.fields[0].value, /Estimated loot/);
  assert.match(embed.fields[0].value, /Military/);
  assert.equal(embed.footer.text, '1–2 of 4 targets · Page 1/2');
  assert.equal(reply.components[0].toJSON().components.length, 2);
});
