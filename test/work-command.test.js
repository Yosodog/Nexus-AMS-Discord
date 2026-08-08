import test from 'node:test';
import assert from 'node:assert/strict';
import { autocomplete, data, execute } from '../src/commands/work.js';
import { embedJson } from './helpers.js';

const GUILD_ID = '123456789012345678';
const USER_ID = '223456789012345678';

const workItem = (overrides = {}) => ({
  work_key: 'loans:42',
  source: { type: 'loans', label: 'Loans', sensitivity: 'restricted' },
  title: 'Review Acme loan',
  summary: 'A safe operational summary.',
  status: { code: 'pending_review', label: 'Pending review', intent: 'pending' },
  actors: {
    requester: { kind: 'nation', key: 'nation:7', label: 'Acme Nation' },
    owner: { kind: 'nation', key: 'nation:8', label: 'Finance Lead' },
    next_actor: 'staff',
  },
  attention: {
    priority: 'p1', severity: 'high', urgency: 'urgent', overdue: true, blocked: true,
    blocker_summary: 'Awaiting verified documents',
  },
  times: {
    entered_queue_at: '2026-08-08T10:00:00Z',
    source_changed_at: '2026-08-08T11:00:00Z',
    due_at: '2026-08-08T12:00:00Z',
  },
  freshness: { state: 'fresh', projected_at: '2026-08-08T11:30:00Z' },
  facts: { risk_band: 'high' },
  context: [{ kind: 'nation', key: 'nation:7', label: 'Acme Nation' }],
  next_action: { key: 'domain.view', label: 'Review in Nexus', deep_link_path: '/admin/loans/42' },
  ...overrides,
});

const interaction = ({ subcommand = 'queue', values = {}, focused = null } = {}) => {
  const subject = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    commandName: 'work',
    user: { id: USER_ID },
    deferred: false,
    replied: false,
    defers: [],
    edits: [],
    responses: [],
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => values[name] ?? null,
      getBoolean: (name) => values[name] ?? null,
      getInteger: (name) => values[name] ?? null,
      getFocused: (withName) => (withName ? focused : focused?.value ?? ''),
    },
    deferReply: async (payload) => {
      subject.deferred = true;
      subject.defers.push(payload);
    },
    editReply: async (payload) => subject.edits.push(payload),
    reply: async (payload) => {
      subject.replied = true;
      subject.edits.push(payload);
    },
    respond: async (choices) => subject.responses.push(choices),
  };
  return subject;
};

test('/work exposes read-only queue and show subcommands with actor-scoped autocomplete', () => {
  const json = data.toJSON();
  assert.equal(json.name, 'work');
  assert.equal(json.dm_permission, false);
  assert.deepEqual(json.options.map(({ name }) => name), ['queue', 'show']);
  assert.equal(json.options[0].options.find(({ name }) => name === 'type').autocomplete, true);
  assert.equal(json.options[1].options.find(({ name }) => name === 'item').autocomplete, true);
});

test('/work queue renders partial Nexus Operations data and forwards supported filters', async () => {
  const calls = [];
  const apiService = {
    baseUrl: 'https://nexus.example',
    getStaffWorkItems: async (actor, params) => {
      calls.push({ actor, params });
      return {
        data: [workItem()],
        meta: {
          complete: false,
          unavailable_sources: [{ type: 'applications', label: 'Applications' }],
          pagination: { current_page: 2, last_page: 3, total: 21 },
        },
      };
    },
  };
  const subject = interaction({
    values: { type: 'loans', priority: 'p1', urgency: 'urgent', freshness: 'fresh', blocked: true, page: 2 },
  });

  await execute(subject, { apiService });

  assert.equal(subject.defers[0].ephemeral, true);
  assert.equal(calls[0].actor.discordUserId, USER_ID);
  assert.deepEqual(calls[0].params, {
    type: 'loans', priority: 'p1', urgency: 'urgent', freshness: 'fresh', blocked: true, page: 2, per_page: 10,
  });
  const embed = embedJson(subject.edits[0]);
  assert.equal(embed.title, 'Nexus Staff Work Queue');
  assert.match(embed.description, /Applications could not be refreshed/);
  assert.match(embed.fields[0].value, /Awaiting verified documents/);
  assert.match(embed.fields[0].value, /https:\/\/nexus\.example\/admin\/loans\/42/);
  assert.match(embed.footer.text, /Partial source data/);
});

test('/work show resolves the opaque work key and renders safe detail only', async () => {
  const calls = [];
  const apiService = {
    baseUrl: 'https://nexus.example',
    getStaffWorkItem: async (...args) => {
      calls.push(args);
      return workItem();
    },
  };
  const subject = interaction({ subcommand: 'show', values: { item: 'loans:42' } });

  await execute(subject, { apiService });

  assert.equal(calls[0][0].discordUserId, USER_ID);
  assert.deepEqual(calls[0].slice(1), ['loans', '42']);
  const embed = embedJson(subject.edits[0]);
  assert.equal(embed.title, 'Review Acme loan');
  assert.match(embed.description, /safe operational summary/);
  assert.match(embed.fields.find(({ name }) => name === 'Safe facts').value, /Risk Band/);
  assert.equal(embed.url, 'https://nexus.example/admin/loans/42');
});

test('/work rejects a stale malformed selection before calling Nexus', async () => {
  let called = false;
  const subject = interaction({ subcommand: 'show', values: { item: 'stale-choice' } });
  await execute(subject, {
    apiService: {
      baseUrl: 'https://nexus.example',
      getStaffWorkItem: async () => { called = true; },
    },
  });

  assert.equal(called, false);
  assert.equal(embedJson(subject.edits[0]).title, 'Request Failed');
  assert.match(embedJson(subject.edits[0]).description, /no longer available/);
});

test('/work autocomplete uses only Nexus-authorized sources and work items', async () => {
  const apiService = {
    getStaffWorkItems: async (_actor, params) => (params.q !== undefined
      ? { data: [workItem()], meta: {} }
      : { data: [], meta: { authorized_sources: { loans: 'Loans', applications: 'Applications' } } }),
  };
  const typeInteraction = interaction({ focused: { name: 'type', value: 'loan' } });
  await autocomplete(typeInteraction, { apiService });
  assert.deepEqual(typeInteraction.responses[0], [{ name: 'Loans', value: 'loans' }]);

  const itemInteraction = interaction({ focused: { name: 'item', value: 'acme' } });
  await autocomplete(itemInteraction, { apiService });
  assert.deepEqual(itemInteraction.responses[0], [{ name: 'Loans · Review Acme loan', value: 'loans:42' }]);
});

test('/work autocomplete fails closed when Nexus is unavailable', async () => {
  const subject = interaction({ focused: { name: 'item', value: '' } });
  await autocomplete(subject, {
    apiService: { getStaffWorkItems: async () => { throw new Error('offline'); } },
  });
  assert.deepEqual(subject.responses[0], []);
});
