import test from 'node:test';
import assert from 'node:assert/strict';
import { button, data, execute, help } from '../src/commands/me.js';
import { escapeMarkdown } from '../src/utils/discordUi.js';
import { embedJson } from './helpers.js';

const USER_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const BASE_URL = 'https://nexus.example';

const makeInteraction = ({ nickname = 'Old Nickname', roleIds = [] } = {}) => {
  const member = {
    id: USER_ID,
    guildId: GUILD_ID,
    nickname,
    roles: {
      cache: new Map([
        [GUILD_ID, { id: GUILD_ID }],
        ...roleIds.map((id) => [id, { id }]),
      ]),
    },
  };
  const subject = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    deferred: false,
    guild: {
      id: GUILD_ID,
      members: { fetch: async (id) => (id === USER_ID ? member : null) },
    },
    deferments: [],
    replies: [],
    deferReply: async (options) => {
      subject.deferred = true;
      subject.deferments.push(options);
    },
    deferUpdate: async () => {
      subject.deferred = true;
    },
    editReply: async (payload) => {
      subject.replies.push(payload);
      return payload;
    },
  };
  return subject;
};

const ready = {
  contract_version: 1,
  state: 'ready',
  message: 'Your Nexus account is ready.',
  identity: {
    display_name: 'Ada Example',
    discord_username: 'ada.example',
    link_state: 'linked',
    linked_at: '2026-08-08T12:00:00Z',
    deep_link_path: '/profile',
  },
  nation: {
    id: 42,
    name: 'Example Nation',
    leader_name: 'Ada Example',
    deep_link_path: '/nations/42',
  },
  alliance: {
    id: 7,
    name: 'Example Alliance',
    deep_link_path: 'https://nexus.example/alliances/7',
  },
  capabilities: {
    items: [
      { key: 'view-audit', label: 'View audit findings' },
      { key: 'operations.work-items', label: 'View open work' },
    ],
    revision: 4,
  },
  open_work: {
    total: 3,
    by_type: { applications: 1, audits: 2 },
    complete: true,
    generated_at: '2026-08-08T12:01:00Z',
  },
  profile_sync: {
    state: 'healthy',
    label: 'Profile is synchronized',
    checked_at: '2026-08-08T12:02:00Z',
    issues: [],
  },
  freshness: {
    state: 'fresh',
    generated_at: '2026-08-08T12:03:00Z',
    source_updated_at: '2026-08-08T12:01:00Z',
  },
  links: {
    profile: '/profile',
    nation: '/nations/42',
    alliance: '/alliances/7',
    audit: '/audit',
    work: 'https://nexus.example/work',
  },
};

const nonReady = (state, overrides = {}) => ({
  contract_version: 1,
  state,
  message: `Nexus says this account is ${state}.`,
  user_action: {
    label: 'Continue in Nexus',
    deep_link_path: '/settings/identity',
  },
  ...overrides,
});

const run = async (response, { baseUrl = BASE_URL, apiError = null } = {}) => {
  const interaction = makeInteraction();
  const calls = [];
  const apiService = {
    baseUrl,
    getMySummary: async (actor) => {
      calls.push(actor);
      if (apiError) throw apiError;
      return response;
    },
  };
  await execute(interaction, { apiService });
  return { interaction, calls };
};

const sessionRecorder = () => {
  const created = [];
  return {
    created,
    create: (value) => {
      created.push(value);
      return `nxs:${created.length.toString().padStart(16, '0')}`;
    },
  };
};

const errorTitle = (interaction) => embedJson(interaction.replies[0]).title;

test('/me is guild-only, has no options, and exposes member help metadata', () => {
  const serialized = data.toJSON();
  assert.equal(serialized.name, 'me');
  assert.equal(serialized.dm_permission, false);
  assert.deepEqual(serialized.options ?? [], []);
  assert.deepEqual(help, {
    audience: 'Members',
    topic: ['member'],
    examples: ['/me'],
    related: ['verify', 'accounts', 'audit', 'help'],
  });
});

test('/me defers ephemerally and calls the summary endpoint with the me actor', async () => {
  const { interaction, calls } = await run(nonReady('unlinked'));
  assert.deepEqual(interaction.deferments, [{ ephemeral: true }]);
  assert.deepEqual(calls, [{
    discordUserId: USER_ID,
    discordGuildId: GUILD_ID,
    discordInteractionId: interaction.id,
    discordCommand: 'me',
    discordAction: 'me',
  }]);
  assert.equal(interaction.replies[0].components.length, 1);
  assert.equal(
    interaction.replies[0].components[0].toJSON().components[0].url,
    'https://nexus.example/settings/identity',
  );
  assert.deepEqual(interaction.replies[0].allowedMentions, { parse: [] });
});

test('renders every supported non-ready state using only the Nexus message and user_action', async () => {
  const states = [
    'unlinked',
    'ambiguous',
    'disabled',
    'nexus_unverified',
    'no_nation',
    'mfa_required',
    'installation_unavailable',
  ];
  for (const state of states) {
    const { interaction } = await run(nonReady(state));
    const embed = embedJson(interaction.replies[0]);
    assert.match(embed.title, /Nexus Account/);
    assert.ok(embed.description.includes(escapeMarkdown(`Nexus says this account is ${state}.`)));
    assert.match(embed.fields.find(({ name }) => name === 'Next step').value, /Continue in Nexus/);
    assert.match(embed.fields.find(({ name }) => name === 'Next step').value, /https:\/\/nexus\.example\/settings\/identity/);
  }

  const { interaction } = await run({ ...nonReady('unlinked'), user_action: null, next_action: {
    label: 'Undocumented alias must not render',
    deep_link_path: '/alias',
  } });
  const embed = embedJson(interaction.replies[0]);
  assert.equal(embed.fields.some(({ name }) => name === 'Next step'), false);
  assert.doesNotMatch(JSON.stringify(embed), /Undocumented alias/);
});

test('renders the complete ready projection without detailed finance or military data', async () => {
  const { interaction } = await run(ready);
  const embed = embedJson(interaction.replies[0]);
  assert.equal(embed.title, 'Nexus Account');
  assert.ok(embed.description.includes('Your Nexus account is ready'));
  assert.match(embed.fields.find(({ name }) => name === 'Identity').value, /Ada Example/);
  assert.ok(embed.fields.find(({ name }) => name === 'Identity').value.includes(escapeMarkdown('ada.example')));
  assert.match(embed.fields.find(({ name }) => name === 'Nation').value, /Example Nation/);
  assert.match(embed.fields.find(({ name }) => name === 'Alliance').value, /Example Alliance/);
  assert.match(embed.fields.find(({ name }) => name === 'Capabilities').value, /view\\-audit/);
  assert.match(embed.fields.find(({ name }) => name === 'Open work').value, /Total: 3/);
  assert.match(embed.fields.find(({ name }) => name === 'Profile sync').value, /healthy/);
  assert.match(embed.fields.find(({ name }) => name === 'Freshness').value, /fresh/);
  assert.match(embed.fields.find(({ name }) => name === 'Nexus links').value, /https:\/\/nexus\.example\/audit/);
  assert.doesNotMatch(JSON.stringify(embed), /balance|finance|loan|military|spy|transaction|war/i);
  const buttons = interaction.replies[0].components[0].toJSON().components;
  assert.deepEqual(buttons.map(({ label }) => label), [
    'Open Nexus profile',
    'Open nation profile',
    'Open alliance profile',
    'Open audit center',
    'Open open work',
  ]);
  assert.ok(buttons.every(({ style }) => style === 5));
});

test('accepts only the three envelopes and rejects missing or wrongly typed closed-v1 fields', async () => {
  for (const response of [{ me: ready }, { data: ready }, ready]) {
    const { interaction } = await run(response);
    assert.equal(errorTitle(interaction), 'Nexus Account');
  }

  const missingSections = ['identity', 'nation', 'alliance', 'capabilities', 'open_work', 'profile_sync', 'freshness', 'links'];
  for (const section of missingSections) {
    const incomplete = { ...ready };
    delete incomplete[section];
    const { interaction } = await run(incomplete);
    assert.equal(errorTitle(interaction), 'Request Failed', section);
  }

  for (const response of [
    { ...ready, contract_version: '1' },
    { ...ready, state: 'READY' },
    { ...ready, message: { text: 'not a safe string' } },
    { ...ready, capabilities: { ...ready.capabilities, items: {} } },
    { ...ready, capabilities: { ...ready.capabilities, revision: 0 } },
    { ...ready, nation: { ...ready.nation, id: 0 } },
    { ...ready, open_work: { ...ready.open_work, complete: 'true' } },
    { ...ready, profile_sync: { ...ready.profile_sync, issues: 'none' } },
    { ...ready, links: [] },
    { ...ready, links: {} },
    { ...ready, status: 'ready', state: undefined },
  ]) {
    const { interaction } = await run(response);
    assert.equal(errorTitle(interaction), 'Request Failed');
  }
});

test('does not interpret undocumented aliases inside the selected payload', async () => {
  const { interaction } = await run({
    contract_version: 1,
    state: 'unlinked',
    message: 'Use the account-link flow in Nexus.',
    next_action: { label: 'Alias action', deep_link_path: '/alias' },
    remediation: { label: 'Alias remediation', deep_link_path: '/remediation' },
  });
  const embed = embedJson(interaction.replies[0]);
  assert.ok(embed.description.includes('account\\-link'));
  assert.equal(embed.fields.some(({ name }) => name === 'Next step'), false);
  assert.doesNotMatch(JSON.stringify(embed), /Alias action|Alias remediation/);

  const { interaction: aliasOnly } = await run({
    contract_version: 1,
    status: 'ready',
    next_action: { label: 'Alias only', deep_link_path: '/alias' },
  });
  assert.equal(errorTitle(aliasOnly), 'Request Failed');
});

test('rejects external same-scheme, cross-origin, and unsafe links', async () => {
  const cases = [
    { ...ready, identity: { ...ready.identity, deep_link_path: 'https://attacker.example/profile' } },
    { ...ready, nation: { ...ready.nation, deep_link_path: 'https://attacker.example/nation' } },
    { ...ready, links: { ...ready.links, audit: 'https://attacker.example/audit' } },
    { ...ready, links: { ...ready.links, audit: 'javascript:alert(1)' } },
    { ...ready, links: { ...ready.links, audit: 'data:text/html,unsafe' } },
  ];
  for (const response of cases) {
    const { interaction } = await run(response);
    assert.equal(errorTitle(interaction), 'Request Failed');
  }
});

test('escapes unsafe text, disables mentions, ignores additive detail fields, and handles API errors', async () => {
  const unsafe = {
    ...ready,
    message: '**<@123456789012345678> @everyone**',
    identity: { ...ready.identity, display_name: '[unsafe]* <@&123456789012345678>' },
    balances: { money: 999999 },
    transactions: [{ id: 1 }],
    military: { wars: 99 },
    war: { target: 'secret' },
    open_work: {
      ...ready.open_work,
      by_type: { ...ready.open_work.by_type, finance: 4, military: 2 },
    },
  };
  const { interaction } = await run(unsafe);
  const embed = embedJson(interaction.replies[0]);
  const rendered = JSON.stringify(embed);
  assert.match(embed.description, /\\\*\\\*/);
  assert.doesNotMatch(rendered, /@everyone|<@&123456789012345678>/);
  assert.doesNotMatch(rendered, /balance|transaction|military|war|finance/i);
  assert.deepEqual(interaction.replies[0].allowedMentions, { parse: [] });

  const { interaction: failed } = await run(null, {
    apiError: Object.assign(new Error('Nexus is down'), { code: 'NETWORK_ERROR' }),
  });
  assert.equal(errorTitle(failed), 'Request Failed');
  assert.match(embedJson(failed.replies[0]).description, /Nexus is down/);
});

test('/me offers profile sync only for Nexus-actionable states', async () => {
  const sessions = sessionRecorder();
  const interaction = makeInteraction();
  const apiService = { baseUrl: BASE_URL, getMySummary: async () => ({
    ...ready,
    profile_sync: { ...ready.profile_sync, state: 'available' },
  }) };
  await execute(interaction, { apiService, sessions });

  assert.equal(interaction.replies[0].components.length, 2);
  assert.equal(interaction.replies[0].components[0].toJSON().components[0].label, 'Sync profile');
  assert.equal(sessions.created[0].event, 'profile-sync-preview');
  assert.equal(sessions.created[0].oneShot, true);

  const unavailable = makeInteraction();
  await execute(unavailable, { apiService: {
    baseUrl: BASE_URL,
    getMySummary: async () => ({ ...ready, profile_sync: { ...ready.profile_sync, state: 'unavailable' } }),
  }, sessions: sessionRecorder() });
  assert.equal(unavailable.replies[0].components.length, 1);
  assert.equal(unavailable.replies[0].components[0].toJSON().components[0].style, 5);
});

test('profile sync previews observed Discord state and confirms only the opaque Nexus intent', async () => {
  const sessions = sessionRecorder();
  const interaction = makeInteraction({
    nickname: 'Old Nickname',
    roleIds: ['423456789012345678', '523456789012345678'],
  });
  const calls = [];
  const apiService = {
    baseUrl: BASE_URL,
    previewMemberProfileSync: async (actor, payload) => {
      calls.push(['preview', actor, payload]);
      return {
        intent: { id: 'a'.repeat(64), expires_at: '2026-08-08T12:10:00Z' },
        summary: {
          description: 'Nexus calculated two role changes.',
          nickname: { current: 'Old Nickname', desired: 'New Nickname', will_change: true },
          roles: { add_count: 1, remove_count: 1, managed_count: 3 },
        },
        warnings: [],
      };
    },
    confirmMemberProfileSync: async (actor, payload) => {
      calls.push(['confirm', actor, payload]);
      return {
        queued: true,
        queue: { id: 'queue-1', created_at: '2026-08-08T12:05:00Z' },
        profile_sync: { state: 'pending', label: 'Discord profile synchronization is queued.' },
      };
    },
  };
  await button(interaction, {
    apiService,
    sessions,
    session: { event: 'profile-sync-preview' },
  });

  assert.deepEqual(calls[0][2], {
    observed: {
      nickname: 'Old Nickname',
      role_ids: ['423456789012345678', '523456789012345678'],
    },
  });
  assert.equal(calls[0][1].discordAction, 'me');
  assert.equal(sessions.created[0].event, 'profile-sync-confirm');
  assert.deepEqual(sessions.created[0].state, { intentId: 'a'.repeat(64) });
  assert.equal(interaction.replies.at(-1).components[0].toJSON().components.length, 2);

  const confirmInteraction = makeInteraction();
  await button(confirmInteraction, {
    apiService,
    sessions,
    session: { event: 'profile-sync-confirm', state: { intentId: 'a'.repeat(64) } },
  });
  assert.deepEqual(calls.at(-1)[2], { intent_id: 'a'.repeat(64) });
  assert.equal(embedJson(confirmInteraction.replies.at(-1)).title, 'Profile Sync Queued');
  assert.doesNotMatch(JSON.stringify(calls.at(-1)[2]), /nickname|role/i);
});

test('profile sync controls reject stale state before calling Nexus', async () => {
  const interaction = makeInteraction();
  let called = false;
  await button(interaction, {
    apiService: {
      confirmMemberProfileSync: async () => { called = true; },
    },
    sessions: sessionRecorder(),
    session: { event: 'profile-sync-confirm', state: { intentId: 'invalid' } },
  });
  assert.equal(called, false);
  assert.equal(embedJson(interaction.replies.at(-1)).title, 'Profile Synchronization Failed');
});
