import test from 'node:test';
import assert from 'node:assert/strict';
import { data, execute } from '../src/commands/audit.js';

const actor = { id: '234567890123456789' };
const makeInteraction = (subcommand, values = {}) => {
  const replies = [];
  return {
    user: actor,
    guildId: '123456789012345678',
    id: '345678901234567890',
    deferred: false,
    options: {
      getSubcommand: () => subcommand,
      getInteger: (name) => values[name] ?? null,
      getString: (name) => values[name] ?? null,
    },
    deferReply: async ({ ephemeral }) => { assert.equal(ephemeral, true); },
    editReply: async (payload) => { replies.push(payload); return payload; },
    replies,
  };
};

test('audit command is guild-only and exposes remediation subcommands', () => {
  const command = data.toJSON();
  assert.equal(command.name, 'audit');
  assert.equal(command.dm_permission, false);
  assert.deepEqual(command.options.map((option) => option.name), ['status', 'acknowledge', 'snooze']);
});

test('audit status renders only the actor audit collection', async () => {
  const interaction = makeInteraction('status');
  let receivedActor;
  await execute(interaction, {
    apiService: {
      baseUrl: 'https://nexus.example',
      getMyAuditFindings: async (value) => {
        receivedActor = value;
        return [{
          id: 7,
          name: 'Warchest below requirement',
          description: 'Deposit enough resources to meet the alliance minimum.',
          priority: 'high',
          target: 'Nation-wide',
          target_type: 'nation',
        }];
      },
    },
  });
  assert.equal(receivedActor.discordUserId, actor.id);
  assert.equal(interaction.replies.length, 1);
  const embed = interaction.replies[0].embeds[0].data;
  assert.equal(embed.title, 'Your Audit Findings');
  assert.match(embed.description, /Open the audit center in Nexus/);
  assert.match(embed.fields[0].name, /Warchest below requirement/);
  assert.match(embed.fields[0].value, /Deposit enough resources/);
});

test('audit acknowledge and snooze forward mutation inputs to Nexus', async () => {
  const calls = [];
  const apiService = {
    acknowledgeAuditFinding: async (_actor, id, payload) => { calls.push(['ack', id, payload]); return {}; },
    snoozeAuditFinding: async (_actor, id, payload) => { calls.push(['snooze', id, payload]); return {}; },
  };

  await execute(makeInteraction('acknowledge', { finding: 7, note: 'Working on it' }), { apiService });
  await execute(makeInteraction('snooze', { finding: 8, hours: 72 }), { apiService });

  assert.deepEqual(calls, [
    ['ack', 7, { note: 'Working on it' }],
    ['snooze', 8, { hours: 72 }],
  ]);
});
