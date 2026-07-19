import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import {
  COLLECTION_PAGE_EVENT,
  collectionMessage,
  collectionPageMessage,
  errorMessage,
  normalizeCollection,
  replyError,
  summarizeItem,
} from '../src/utils/commandSupport.js';
import {
  allianceUrl,
  buildEmbed,
  cleanText,
  escapeMarkdown,
  formatDiscordTime,
  formatMilitary,
  formatMoney,
  formatNumber,
  formatPercent,
  formatResources,
  markdownLink,
  nationUrl,
  pluralize,
  resolveDeepLink,
  safeUrl,
  statusLabel,
  statusMessage,
  statusTone,
  titleCase,
  truncate,
  variantConfig,
} from '../src/utils/discordUi.js';
import { registerInteractionListener } from '../src/listeners/interactionCreate.js';
import { createEventClient, createLogger, embedJson } from './helpers.js';

const sessionStore = () => {
  let sequence = 0;
  return new InteractionSessionStore({
    createToken: () => `token${String(sequence += 1).padStart(27, '0')}`,
  });
};

const raidTarget = (id) => ({
  nation_id: id,
  nation_name: `Target Nation ${id}`,
  leader_name: `Leader ${id}`,
  alliance_id: 456,
  alliance_name: 'Target Alliance',
  cities: 40,
  score: 9020.25,
  estimated_value: 42157764,
  last_beige_value: 38750000,
  last_active: '2026-07-19T12:00:00Z',
  defensive_wars: 1,
  military: {
    soldiers: 120000,
    tanks: 8000,
    aircraft: 2100,
    ships: 75,
    spies: 55,
    missiles: 4,
    nukes: 2,
  },
  nation_url: `https://politicsandwar.com/nation/id=${id}`,
  alliance_url: 'https://politicsandwar.com/alliance/id=456',
});

test('raid collections render useful target context and paginate local arrays', () => {
  const sessions = sessionStore();
  const payload = collectionMessage({
    title: 'Raid Targets',
    description: 'Sorted by estimated loot.',
    collection: normalizeCollection([1, 2, 3, 4].map(raidTarget)),
    commandName: 'raid',
    userId: '123456789012345678',
    sessions,
    variant: 'raid',
    baseUrl: 'https://nexus.example',
  });

  const embed = embedJson(payload);
  assert.equal(embed.fields.length, 2);
  assert.match(embed.fields[0].name, /Target Nation 1/);
  assert.match(embed.fields[0].name, /Leader 1/);
  assert.match(embed.fields[0].value, /Target Alliance/);
  assert.match(embed.fields[0].value, /Estimated loot:\*\* \$42,157,764/);
  assert.match(embed.fields[0].value, /Soldiers:\*\* 120,000/);
  assert.equal(embed.footer.text, '1–2 of 4 targets · Page 1/2');
  assert.equal(payload.components.length, 1);

  const buttons = payload.components[0].toJSON().components;
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, false);

  const next = sessions.resolve(buttons[1].custom_id, '123456789012345678');
  assert.equal(next.event, COLLECTION_PAGE_EVENT);
  assert.equal(next.state.page, 2);

  const secondPage = collectionPageMessage({
    state: next.state,
    sessions,
    userId: '123456789012345678',
  });
  const secondEmbed = embedJson(secondPage);
  assert.equal(secondEmbed.fields.length, 2);
  assert.match(secondEmbed.fields[0].name, /Target Nation 3/);
  assert.equal(secondEmbed.footer.text, '3–4 of 4 targets · Page 2/2');
});

test('collection pagination controls are routed without command-specific button handlers', async () => {
  const sessions = sessionStore();
  const firstPage = collectionMessage({
    title: 'Raid Targets',
    collection: normalizeCollection([1, 2, 3].map(raidTarget)),
    commandName: 'raid',
    userId: '123456789012345678',
    sessions,
    variant: 'raid',
  });
  const nextId = firstPage.components[0].toJSON().components[1].custom_id;
  const client = createEventClient();
  const logger = createLogger();
  let updatedPayload = null;
  registerInteractionListener(client, new Map(), logger, { sessions }, '223456789012345678');

  const interaction = {
    customId: nextId,
    guildId: '223456789012345678',
    user: { id: '123456789012345678' },
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isModalSubmit: () => false,
    deferUpdate: async () => { interaction.deferred = true; },
    editReply: async (payload) => { updatedPayload = payload; },
  };

  await client.handlers.get(Events.InteractionCreate)(interaction);

  assert.ok(updatedPayload);
  assert.match(embedJson(updatedPayload).fields[0].name, /Target Nation 3/);
  assert.equal(logger.entries.warn.length, 0);
  assert.equal(logger.entries.error.length, 0);
});

test('embed builder enforces Discord per-part and total text budgets', () => {
  const embed = buildEmbed({
    title: 'T'.repeat(1000),
    description: 'D'.repeat(10000),
    fields: Array.from({ length: 25 }, (_, index) => ({
      name: `Field ${index} ${'N'.repeat(500)}`,
      value: 'V'.repeat(3000),
    })),
    footer: 'F'.repeat(4000),
  }).toJSON();

  const totalCharacters = embed.title.length
    + (embed.description?.length ?? 0)
    + (embed.footer?.text.length ?? 0)
    + (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
  assert.ok(embed.title.length <= 256);
  assert.ok((embed.description?.length ?? 0) <= 4096);
  assert.ok((embed.fields ?? []).every((field) => field.name.length <= 256 && field.value.length <= 1024));
  assert.ok(totalCharacters <= 6000);
});

test('shared formatters produce readable values and reject unsafe links', () => {
  assert.equal(formatMoney(42157764), '$42,157,764');
  assert.equal(formatResources({ money: 1000000, steel: 2500, food: 0 }), '**Money:** $1,000,000 · **Steel:** 2,500');
  assert.equal(formatDiscordTime('2026-07-19T12:00:00Z'), '<t:1784462400:R>');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://nexus.example/path'), 'https://nexus.example/path');
});

test('shared UI primitives handle empty, malformed, and alternate value shapes', () => {
  assert.equal(cleanText(null, 'Missing'), 'Missing');
  assert.equal(cleanText('  one\t two\n\n\nthree\u0000  '), 'one two\n\nthree');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(escapeMarkdown('a*b'), 'a\\*b');
  assert.equal(titleCase('war_counter'), 'War Counter');
  assert.equal(formatNumber('not-a-number'), '—');
  assert.equal(formatMoney('not-a-number'), '—');
  assert.equal(formatPercent(0.125), '12.5%');
  assert.equal(formatPercent(25), '25%');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatDiscordTime(null), '—');
  assert.equal(formatDiscordTime(1_784_462_400), '<t:1784462400:R>');
  assert.equal(formatDiscordTime(new Date('invalid')), '—');
  assert.equal(safeUrl(null), null);
  assert.equal(safeUrl('not a url'), null);
  assert.equal(resolveDeepLink('https://nexus.example/base', '/requests/1'), 'https://nexus.example/requests/1');
  assert.equal(resolveDeepLink('https://nexus.example', 'https://example.com/item'), 'https://example.com/item');
  assert.equal(resolveDeepLink('not-a-url', '/requests/1'), null);
  assert.equal(markdownLink('Unsafe *label*', 'javascript:alert(1)'), 'Unsafe \\*label\\*');
  assert.equal(statusLabel(null), null);
  assert.equal(statusLabel('custom_state'), '• Custom State');
  assert.equal(statusTone('approved'), 'success');
  assert.equal(statusTone('custom_state', 'neutral'), 'neutral');
  assert.equal(formatResources(null), '—');
  assert.equal(formatResources({ money: 0 }), 'None');
  assert.equal(formatResources({ money: 0 }, { includeZero: true }), '**Money:** $0');
  assert.equal(formatMilitary(null), null);
  assert.equal(formatMilitary({}), null);
  assert.match(formatMilitary({ soldiers: 1_000 }), /1,000/);
  assert.equal(nationUrl({ nation_id: 7 }), 'https://politicsandwar.com/nation/id=7');
  assert.equal(allianceUrl({ alliance_id: 8 }), 'https://politicsandwar.com/alliance/id=8');
  assert.equal(variantConfig('unknown'), variantConfig('generic'));
  assert.equal(pluralize(1, 'target'), 'target');
  assert.equal(pluralize(2, 'target'), 'targets');
  assert.deepEqual(statusMessage({ title: 'Ready', components: ['control'] }).components, ['control']);
});

test('collection normalization clamps malformed metadata and marks remote pages', () => {
  assert.deepEqual(normalizeCollection(['a']), {
    items: ['a'], page: 1, pages: 1, total: 1, remote: false,
  });
  assert.deepEqual(normalizeCollection({
    items: ['a', 'b'],
    pagination: { current_page: 99, last_page: 3, total: 8, per_page: 3 },
  }), {
    items: ['a', 'b'], page: 3, pages: 3, total: 8, perPage: 3, remote: true,
  });
});

test('collection support handles API envelopes, remote pages, empty states, and errors', async () => {
  for (const key of [
    'accounts', 'transactions', 'available', 'requests', 'loans', 'applications',
    'wars', 'assignments', 'targets', 'data',
  ]) {
    assert.deepEqual(normalizeCollection({ [key]: ['item'] }).items, ['item']);
  }
  assert.throws(() => normalizeCollection({ items: 'invalid' }), /items array/);

  const remote = normalizeCollection({
    data: ['third', 'fourth'],
    meta: { page: 2, pages: 3, total: 6, page_size: 2 },
  });
  const sessions = sessionStore();
  const remotePayload = collectionMessage({
    title: 'Remote Results',
    collection: remote,
    commandName: 'remote',
    userId: '123456789012345678',
    sessions,
    event: 'remote-page',
    state: { filter: 'open' },
    pageSize: 99,
    noun: 'result',
  });
  assert.equal(embedJson(remotePayload).footer.text, '3–4 of 6 results · Page 2/3');
  const remoteButtons = remotePayload.components[0].toJSON().components;
  assert.equal(remoteButtons[0].disabled, false);
  assert.equal(remoteButtons[1].disabled, false);
  assert.deepEqual(sessions.resolve(remoteButtons[0].custom_id, '123456789012345678').state, {
    filter: 'open', page: 1,
  });
  assert.deepEqual(sessions.resolve(remoteButtons[1].custom_id, '123456789012345678').state, {
    filter: 'open', page: 3,
  });

  const emptyPayload = collectionMessage({
    title: 'Nothing Here',
    collection: normalizeCollection([]),
    empty: 'No matching records.',
    commandName: 'empty',
    userId: '123456789012345678',
  });
  assert.equal(embedJson(emptyPayload).description, 'No matching records.');
  assert.equal(embedJson(emptyPayload).footer, undefined);
  assert.deepEqual(emptyPayload.components, []);
  assert.throws(() => collectionPageMessage({ state: {}, sessions, userId: '1' }), /unavailable/);

  assert.match(summarizeItem('simple value'), /simple value/);
  assert.equal(errorMessage({ code: 'FORBIDDEN' }), 'You do not have permission to do that.');
  assert.equal(errorMessage({ code: 'VALIDATION_ERROR', message: 'Use a positive amount.' }), 'Use a positive amount.');
  assert.equal(errorMessage({ message: 'Short upstream message.' }), 'Short upstream message.');
  assert.match(errorMessage({ message: 'x'.repeat(301) }), /unavailable/);

  let replied = null;
  await replyError({
    deferred: false,
    replied: false,
    reply: async (payload) => { replied = payload; },
  }, { code: 'NOT_FOUND' });
  assert.match(embedJson(replied).description, /no longer available/);

  let edited = null;
  await replyError({
    deferred: true,
    replied: false,
    editReply: async (payload) => { edited = payload; },
  }, { code: 'FEATURE_DISABLED' }, 'Feature Unavailable');
  assert.equal(embedJson(edited).title, 'Feature Unavailable');
});

test('interaction sessions evict the oldest controls when the store reaches its bound', () => {
  let sequence = 0;
  const sessions = new InteractionSessionStore({
    maxEntries: 2,
    createToken: () => `bounded${String(sequence += 1).padStart(25, '0')}`,
  });
  const first = sessions.create({ commandName: 'raid', userId: '1', event: 'page' });
  const second = sessions.create({ commandName: 'raid', userId: '1', event: 'page' });
  const third = sessions.create({ commandName: 'raid', userId: '1', event: 'page' });

  assert.equal(sessions.resolve(first, '1'), null);
  assert.equal(sessions.resolve(second, '1')?.commandName, 'raid');
  assert.equal(sessions.resolve(third, '1')?.commandName, 'raid');
});
