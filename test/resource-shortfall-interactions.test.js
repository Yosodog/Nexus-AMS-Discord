import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleResourceShortfallInteraction,
  parseResourceShortfallCustomId,
  resourceShortfallCustomId,
} from '../src/interactions/resourceShortfall.js';

const GUILD_ID = '123456789012345678';
const USER_ID = '223456789012345678';
const INTENT_TOKEN = 'a'.repeat(64);

const interaction = ({ values = [] } = {}) => {
  const subject = {
    id: '323456789012345678',
    guildId: null,
    user: { id: USER_ID },
    values,
    deferred: false,
    replied: false,
    replies: [],
    edits: [],
    deferReply: async () => { subject.deferred = true; },
    deferUpdate: async () => { subject.deferred = true; },
    reply: async (payload) => { subject.replied = true; subject.replies.push(payload); },
    editReply: async (payload) => { subject.edits.push(payload); return payload; },
  };
  return subject;
};

const control = (action, options = {}) => parseResourceShortfallCustomId(resourceShortfallCustomId({
  action,
  guildId: GUILD_ID,
  occurrenceId: options.occurrenceId ?? 91,
  intentToken: options.intentToken ?? INTENT_TOKEN,
}));

const draft = (accountId = 7) => ({
  fulfillment: {
    id: INTENT_TOKEN,
    status: 'draft',
    account_id: accountId,
    mode: 'mmr_purchase_withdrawal',
    resources: { coal: '115.00', money: '0.00' },
    purchase_lines: { coal: { qty: '100.00', ppu: '2.00', spend: '200.00' } },
    quoted_total: '200.00',
    purchase_is_final: true,
    expires_at: '2026-09-10T18:15:00Z',
  },
  account: { id: accountId, name: 'Primary' },
  review: { requires_approval: false, pending_reason: null },
});

test('resource shortfall controls are compact, guild-bound, and reject malformed identifiers', () => {
  const customId = resourceShortfallCustomId({ action: 'open', guildId: GUILD_ID, occurrenceId: 91 });
  assert.equal(customId, `nxs:rsa:o:${GUILD_ID}:91`);
  assert.deepEqual(parseResourceShortfallCustomId(customId), {
    action: 'o',
    guildId: GUILD_ID,
    occurrenceId: '91',
    intentToken: null,
  });
  assert.equal(parseResourceShortfallCustomId(`nxs:rsa:c:${GUILD_ID}:not-a-token`), null);
  assert.throws(
    () => resourceShortfallCustomId({ action: 'confirm', guildId: 'bad', intentToken: INTENT_TOKEN }),
    /valid action and guild/i,
  );
});

test('multiple eligible accounts render a selector and the selected account creates a server draft', async () => {
  const calls = [];
  const apiService = {
    getResourceShortfallOptions: async (actor, occurrenceId) => {
      calls.push({ name: 'options', actor, occurrenceId });
      return {
        accounts: [
          { account_id: 7, account_name: 'Primary', mode: 'withdrawal', quoted_total: '0.00' },
          { account_id: 8, account_name: 'Reserve', mode: 'mmr_purchase_withdrawal', quoted_total: '200.00' },
        ],
      };
    },
    createResourceShortfallDraft: async (actor, occurrenceId, accountId) => {
      calls.push({ name: 'draft', actor, occurrenceId, accountId });
      return draft(Number(accountId));
    },
  };

  const opened = interaction();
  await handleResourceShortfallInteraction(opened, {
    apiService,
    resourceShortfallControl: control('open'),
  });
  assert.equal(opened.deferred, true);
  assert.equal(opened.edits[0].components[0].toJSON().components[0].type, 3);
  assert.deepEqual(calls.map(({ name }) => name), ['options']);

  const selected = interaction({ values: ['8'] });
  await handleResourceShortfallInteraction(selected, {
    apiService,
    resourceShortfallControl: control('select'),
  });
  assert.deepEqual(calls.map(({ name }) => name), ['options', 'draft']);
  assert.equal(calls[1].accountId, '8');
  assert.match(selected.edits[0].embeds[0].toJSON().footer.text, /purchase becomes final/i);
  const buttons = selected.edits[0].components[0].toJSON().components;
  assert.equal(buttons[0].custom_id, `nxs:rsa:c:${GUILD_ID}:${INTENT_TOKEN}`);
  assert.equal(buttons[1].custom_id, `nxs:rsa:x:${GUILD_ID}:${INTENT_TOKEN}`);
});

test('one eligible account skips selection and confirmation renders authoritative purchase results', async () => {
  const apiService = {
    getResourceShortfallOptions: async () => ({
      accounts: [{ account_id: 7, account_name: 'Primary', mode: 'withdrawal', quoted_total: '0.00' }],
    }),
    createResourceShortfallDraft: async () => draft(),
    confirmResourceShortfallFulfillment: async () => ({
      fulfillment_status: 'pending_review',
      transaction: { id: 55, resources: { coal: '115.00' } },
      purchase: { id: 66, total_spent: '200.00', allocation_mode: 'alert_on_demand' },
    }),
  };

  const opened = interaction();
  await handleResourceShortfallInteraction(opened, {
    apiService,
    resourceShortfallControl: control('open'),
  });
  assert.equal(opened.edits[0].embeds[0].toJSON().title, 'Confirm Resource Shortfall Fulfillment');

  const confirmed = interaction();
  await handleResourceShortfallInteraction(confirmed, {
    apiService,
    resourceShortfallControl: control('confirm'),
  });
  const embed = confirmed.edits[0].embeds[0].toJSON();
  assert.equal(embed.title, 'Withdrawal Submitted for Review');
  assert.match(embed.footer.text, /MMR charge remains final/i);
  assert.match(JSON.stringify(embed.fields), /#66/);
});

test('no remaining account reports a terminal informational result without creating a draft', async () => {
  let draftCreated = false;
  const subject = interaction();
  await handleResourceShortfallInteraction(subject, {
    apiService: {
      getResourceShortfallOptions: async () => ({ accounts: [] }),
      createResourceShortfallDraft: async () => { draftCreated = true; },
    },
    resourceShortfallControl: control('open'),
  });

  assert.equal(draftCreated, false);
  assert.equal(subject.edits[0].embeds[0].toJSON().title, 'Resources No Longer Actionable');
  assert.deepEqual(subject.edits[0].components, []);
});
