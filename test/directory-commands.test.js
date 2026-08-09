import test from 'node:test';
import assert from 'node:assert/strict';
import { data as allianceData, autocomplete as allianceAutocomplete, button as allianceButton, execute as allianceExecute } from '../src/commands/alliance.js';
import { data as nationData, autocomplete as nationAutocomplete, button as nationButton, execute as nationExecute } from '../src/commands/nation.js';
import { data as contextData, execute as contextExecute } from '../src/commands/who-context.js';
import { execute as whoExecute } from '../src/commands/who.js';
import { embedJson } from './helpers.js';

const USER_ID = '123456789012345678';
const TARGET_ID = '223456789012345678';
const GUILD_ID = '323456789012345678';

const sessionsRecorder = () => {
  const created = [];
  return {
    created,
    create: (value) => {
      created.push(value);
      return `nxs:${created.length.toString().padStart(16, '0')}`;
    },
  };
};

const interaction = ({ option = null, targetUser = null, focused = '' } = {}) => {
  const subject = {
    id: '423456789012345678',
    user: { id: USER_ID },
    targetUser,
    guildId: GUILD_ID,
    deferred: false,
    replied: false,
    edits: [],
    follows: [],
    responses: [],
    options: {
      getUser: () => option,
      getString: () => option,
      getFocused: () => focused,
    },
    deferReply: async (payload) => {
      subject.deferred = true;
      subject.deferPayload = payload;
    },
    deferUpdate: async () => { subject.deferred = true; },
    editReply: async (payload) => { subject.edits.push(payload); return payload; },
    reply: async (payload) => { subject.replied = true; subject.edits.push(payload); return payload; },
    followUp: async (payload) => { subject.follows.push(payload); return payload; },
    respond: async (payload) => { subject.responses.push(payload); },
  };
  return subject;
};

const identity = {
  contract_version: 1,
  state: 'ready',
  display_name: 'Example Member',
  discord_username: 'example.member',
  deep_link_path: '/user/dashboard',
  nation: { id: 42, name: 'Example Nation', leader_name: 'Example Leader' },
  alliance: { id: 7, name: 'Example Alliance', acronym: 'EA' },
  freshness: {
    state: 'fresh',
    source_updated_at: '2026-08-08T12:00:00Z',
  },
};

const nation = {
  contract_version: 1,
  kind: 'nation',
  id: 42,
  name: 'Example Nation',
  leader_name: 'Example Leader',
  alliance: { id: 7, name: 'Example Alliance', acronym: 'EA' },
  alliance_position: 'MEMBER',
  cities: 25,
  score: 2500.5,
  color: 'blue',
  vacation_mode_turns: 0,
  shareable: true,
  freshness: { state: 'stale', source_updated_at: '2026-08-08T12:00:00Z' },
  resources: { money: 999999999 },
  military: { soldiers: 999999 },
};

const alliance = {
  contract_version: 1,
  kind: 'alliance',
  id: 7,
  name: 'Example Alliance',
  acronym: 'EA',
  rank: 12,
  score: 50000.25,
  average_score: 2000.1,
  color: 'blue',
  accepting_members: true,
  nation_count: 30,
  shareable: true,
  freshness: { state: 'fresh', source_updated_at: '2026-08-08T12:00:00Z' },
  bank: { money: 999999999 },
};

test('/who and the user context action use the same always-ephemeral Nexus projection', async () => {
  const calls = [];
  const apiService = {
    baseUrl: 'https://nexus.example',
    getDirectoryDiscordUser: async (actor, id) => { calls.push({ actor, id }); return identity; },
  };
  const slash = interaction({ option: { id: TARGET_ID } });
  await whoExecute(slash, { apiService });
  assert.equal(slash.deferPayload.ephemeral, true);
  assert.equal(calls[0].id, TARGET_ID);
  assert.equal(embedJson(slash.edits[0]).title, 'Nexus Identity');
  assert.deepEqual(slash.edits[0].allowedMentions, { parse: [] });

  const context = interaction({ targetUser: { id: TARGET_ID } });
  await contextExecute(context, { apiService });
  assert.equal(context.deferPayload.ephemeral, true);
  assert.equal(calls[1].id, TARGET_ID);
  assert.equal(contextData.toJSON().type, 2);
});

test('/nation uses Nexus autocomplete and requires an explicit one-shot Share action', async () => {
  const auto = interaction({ focused: 'Example' });
  const calls = [];
  const apiService = {
    searchDirectoryNations: async (actor, query) => {
      calls.push(['search', actor, query]);
      return { items: [{ id: 42, name: 'Example Nation', description: 'Example Leader · EA' }] };
    },
    getDirectoryNation: async (actor, id) => { calls.push(['get', actor, id]); return nation; },
  };
  await nationAutocomplete(auto, { apiService });
  assert.equal(auto.responses[0][0].value, '42');

  const sessions = sessionsRecorder();
  const command = interaction({ option: '42' });
  await nationExecute(command, { apiService, sessions });
  assert.equal(command.deferPayload.ephemeral, true);
  assert.equal(embedJson(command.edits[0]).title, 'Example Nation');
  assert.equal(sessions.created[0].event, 'share');
  assert.equal(sessions.created[0].oneShot, true);
  assert.equal(command.edits[0].components[0].toJSON().components[0].label, 'Share public summary');
  assert.doesNotMatch(JSON.stringify(command.edits[0]), /999999999|soldiers|military|resources/i);

  const share = interaction();
  await nationButton(share, {
    apiService,
    session: { event: 'share', state: { entityId: '42' } },
  });
  assert.equal(share.follows[0].ephemeral, false);
  assert.deepEqual(share.follows[0].allowedMentions, { parse: [] });
  assert.doesNotMatch(JSON.stringify(share.follows[0]), /999999999|soldiers|military|resources/i);
  assert.deepEqual(share.edits[0].components, []);
});

test('/alliance uses Nexus autocomplete and publishes only the allowlisted projection', async () => {
  const auto = interaction({ focused: 'EA' });
  const apiService = {
    searchDirectoryAlliances: async () => ({
      items: [{ id: 7, name: 'Example Alliance', description: 'EA · Rank #12' }],
    }),
    getDirectoryAlliance: async () => alliance,
  };
  await allianceAutocomplete(auto, { apiService });
  assert.equal(auto.responses[0][0].value, '7');

  const sessions = sessionsRecorder();
  const command = interaction({ option: '7' });
  await allianceExecute(command, { apiService, sessions });
  assert.equal(command.deferPayload.ephemeral, true);
  assert.equal(sessions.created[0].event, 'share');
  assert.doesNotMatch(JSON.stringify(command.edits[0]), /bank|999999999/i);

  const share = interaction();
  await allianceButton(share, {
    apiService,
    session: { event: 'share', state: { entityId: '7' } },
  });
  assert.equal(share.follows[0].ephemeral, false);
  assert.doesNotMatch(JSON.stringify(share.follows[0]), /bank|999999999/i);
  assert.deepEqual(share.edits[0].components, []);
});

test('directory command definitions preserve top-level domain names and autocomplete', () => {
  const nationJson = nationData.toJSON();
  const allianceJson = allianceData.toJSON();
  assert.equal(nationJson.name, 'nation');
  assert.equal(nationJson.options[0].autocomplete, true);
  assert.equal(allianceJson.name, 'alliance');
  assert.equal(allianceJson.options[0].autocomplete, true);
});
