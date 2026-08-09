import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandType } from 'discord.js';
import {
  connectionCommandName, data, execute,
} from '../src/commands/application-review-context.js';
import { embedJson } from './helpers.js';

const USER_ID = '123456789012345678';
const APPLICANT_ID = '223456789012345678';
const GUILD_ID = '323456789012345678';

test('application review context action reuses the canonical staff review flow', async () => {
  const serialized = data.toJSON();
  assert.equal(serialized.name, 'Review Nexus application');
  assert.equal(serialized.type, ApplicationCommandType.User);
  assert.equal(connectionCommandName, 'applications');

  const calls = [];
  const sessions = [];
  const edits = [];
  const interaction = {
    id: '423456789012345678',
    guildId: GUILD_ID,
    channelId: '523456789012345678',
    commandName: 'Review Nexus application',
    user: { id: USER_ID },
    targetUser: { id: APPLICANT_ID },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  };
  await execute(interaction, {
    apiService: {
      baseUrl: 'https://nexus.example',
      getStaffApplications: async (...args) => {
        calls.push(['lookup', ...args]);
        return [{ id: 41, token: 'application-41', applicant_name: 'Applicant' }];
      },
      getStaffApplicationReview: async (...args) => {
        calls.push(['review', ...args]);
        return {
          summary: 'Nexus-authorized review summary.',
          application: {
            id: 41,
            token: 'application-41',
            applicant_name: 'Applicant',
            status: 'pending',
            discord_user_id: APPLICANT_ID,
            deep_link_path: '/admin/applications/41',
            internal_risk_score: 'must not render',
          },
        };
      },
    },
    sessions: {
      create: (session) => {
        sessions.push(session);
        return `session-${sessions.length}`;
      },
    },
  });

  assert.equal(calls[0][2].applicant_discord_id, APPLICANT_ID);
  assert.equal(calls[0][2].discord_channel_id, undefined);
  assert.deepEqual(calls[1][2], { application: 'application-41' });
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(({ event }) => event), ['approve-start', 'deny-start']);
  assert.ok(sessions.every(({ commandName, oneShot }) => commandName === 'applications' && oneShot === true));
  assert.equal(embedJson(edits[0]).title, 'Application Review — Applicant');
  assert.doesNotMatch(JSON.stringify(embedJson(edits[0])), /must not render/);
  assert.deepEqual(edits[0].allowedMentions, { parse: [] });
});
