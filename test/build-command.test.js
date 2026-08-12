import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessage,
  data,
  execute,
} from '../src/commands/build.js';
import { embedJson } from './helpers.js';

const projection = {
  contract_version: 1,
  state: 'ready',
  message: 'Current recommended city build from Nexus.',
  nation: { id: 42, name: 'Example Nation' },
  deep_link_path: '/audit',
  recommendation: {
    target_infrastructure: 2500,
    land_used: 2500,
    used_slots: 50,
    available_slots: 50,
    cities_below_target: 2,
    infrastructure_shortfall: 125.5,
    converted_profit_per_day: 1234567.89,
    market_stale: true,
    groups: [
      {
        key: 'power',
        label: 'Power',
        items: [{ field: 'nuclear_power', label: 'Nuclear Power Plant', count: 1 }],
      },
      {
        key: 'military',
        label: 'Military',
        items: [{ field: 'hangar', label: 'Hangar', count: 5 }],
      },
    ],
    calculated_at: '2026-08-11T12:00:00Z',
  },
};

const interaction = () => {
  const subject = {
    id: '423456789012345678',
    user: { id: '123456789012345678' },
    guildId: '323456789012345678',
    deferred: false,
    replied: false,
    edits: [],
    options: {},
    deferReply: async (payload) => {
      subject.deferred = true;
      subject.deferPayload = payload;
    },
    editReply: async (payload) => {
      subject.edits.push(payload);
      return payload;
    },
  };
  return subject;
};

test('/build is an option-free, server-only member command', () => {
  const definition = data.toJSON();
  assert.equal(definition.name, 'build');
  assert.equal(definition.dm_permission, false);
  assert.deepEqual(definition.options ?? [], []);
});

test('/build renders the actor-scoped recommendation ephemerally', async () => {
  const command = interaction();
  const actors = [];
  const apiService = {
    baseUrl: 'https://nexus.example',
    getMyBuildRecommendation: async (actor) => {
      actors.push(actor);
      return projection;
    },
  };

  await execute(command, { apiService });

  assert.equal(command.deferPayload.ephemeral, true);
  assert.equal(actors[0].discordCommand, 'build');
  const embed = embedJson(command.edits[0]);
  assert.equal(embed.title, 'Example Nation Recommended Build');
  assert.match(embed.description, /Open Audit Center in Nexus/);
  assert.match(embed.fields.find(({ name }) => name === 'Power').value, /1× Nuclear Power Plant/);
  assert.match(embed.fields.find(({ name }) => name === 'Attention').value, /2 cities/);
  assert.deepEqual(command.edits[0].allowedMentions, { parse: [] });
  assert.equal(command.edits[0].components, undefined);
});

test('/build renders a friendly unavailable state', () => {
  const message = buildMessage({
    contract_version: 1,
    state: 'unavailable',
    message: 'No current build recommendation is available.',
    nation: { id: 42, name: 'Example Nation' },
    deep_link_path: '/audit',
  }, 'https://nexus.example');

  const embed = embedJson(message);
  assert.equal(embed.title, 'Example Nation Recommended Build');
  assert.match(embed.description, /No current build recommendation is available/);
  assert.match(embed.description, /https:\/\/nexus\.example\/audit/);
});

test('/build rejects malformed recommendation projections', () => {
  assert.throws(
    () => buildMessage({ ...projection, recommendation: { ...projection.recommendation, groups: 'invalid' } }),
    /invalid build recommendation projection/,
  );
  assert.throws(
    () => buildMessage({ ...projection, deep_link_path: 'https://example.org/phishing' }),
    /invalid build recommendation projection/,
  );
});
