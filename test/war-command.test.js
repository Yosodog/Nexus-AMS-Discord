import test from 'node:test';
import assert from 'node:assert/strict';
import { button, execute } from '../src/commands/war.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { embedJson } from './helpers.js';

const USER_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';

const assignment = (id) => ({
  id,
  type: 'plan',
  label: `Target ${id}`,
  status: 'planning',
  target: {
    nation_id: 1000 + id,
    nation_name: `Target Nation ${id}`,
    leader_name: `Leader ${id}`,
  },
  source: { name: 'Operation Atlas' },
});

test('/war assignments keeps response controls aligned with every paginated page', async () => {
  const sessions = new InteractionSessionStore();
  const context = {
    sessions,
    apiService: {
      baseUrl: 'https://nexus.example',
      getMyWarAssignments: async () => [assignment(1), assignment(2), assignment(3)],
    },
  };
  let firstPayload = null;
  const commandInteraction = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: { getSubcommand: () => 'assignments' },
    deferReply: async () => {},
    editReply: async (payload) => { firstPayload = payload; },
  };

  await execute(commandInteraction, context);

  assert.equal(embedJson(firstPayload).footer.text, '1–2 of 3 assignments · Page 1/2');
  assert.equal(firstPayload.components.length, 3);
  const nextId = firstPayload.components[0].toJSON().components[1].custom_id;
  const session = sessions.resolve(nextId, USER_ID);
  assert.equal(session.event, 'assignments-page');
  assert.equal(session.state.page, 2);

  let secondPayload = null;
  const buttonInteraction = {
    user: { id: USER_ID },
    deferUpdate: async () => {},
    editReply: async (payload) => { secondPayload = payload; },
  };
  await button(buttonInteraction, { ...context, session });

  const secondEmbed = embedJson(secondPayload);
  assert.equal(secondEmbed.footer.text, '3–3 of 3 assignments · Page 2/2');
  assert.match(secondEmbed.fields[0].name, /Target Nation 3/);
  assert.equal(secondPayload.components.length, 2);
  assert.match(secondPayload.components[1].toJSON().components[0].label, /Acknowledge Target 3/);
});

test('/war simulate uses readable plain-message continuation parts for long summaries', async () => {
  const replies = [];
  const followUps = [];
  const interaction = {
    id: '323456789012345678',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    options: {
      getSubcommand: () => 'simulate',
      getString: () => 'war-token',
    },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
    followUp: async (payload) => { followUps.push(payload); },
  };
  const summary = Array.from({ length: 25 }, (_, index) => `Turn ${index + 1}: ${'simulation detail '.repeat(18)}`).join('\n\n');

  await execute(interaction, {
    apiService: { getWarSimulation: async () => ({ summary }) },
  });

  const messages = [...replies, ...followUps];
  assert.equal(replies.length, 1);
  assert.ok(followUps.length > 0);
  assert.ok(messages.every((message) => message.content.length <= 2_000));
  assert.ok(messages.every((message) => message.embeds.length === 0));
  assert.match(messages[0].content, /## ⚔️ War Simulation/);
  assert.match(messages.at(-1).content, /Verify the live war state before acting/);
  assert.ok(followUps.every((message) => message.ephemeral === true));
});
