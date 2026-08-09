import test from 'node:test';
import assert from 'node:assert/strict';
import { button as confirmVerify, execute as executeVerify } from '../src/commands/verify.js';
import { ApiContractError } from '../src/services/ApiService.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { createLogger, embedJson } from './helpers.js';

const CODE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const INTENT_ID = 'v'.repeat(64);
const USER_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';

function createVerifyInteraction(code = CODE) {
  const interaction = {
    id: '323456789012345678',
    commandName: 'verify',
    nexusCommandName: 'verify',
    user: {
      id: USER_ID,
      username: 'Tester',
      globalName: 'Test Global',
      tag: 'Tester#0001',
    },
    guildId: GUILD_ID,
    deferred: false,
    replied: false,
    replies: [],
    edits: [],
    options: { getString: () => code },
    reply: async (payload) => {
      interaction.replied = true;
      interaction.replies.push(payload);
    },
    deferReply: async (payload) => {
      interaction.deferred = true;
      interaction.deferPayload = payload;
    },
    editReply: async (payload) => interaction.edits.push(payload),
  };
  return interaction;
}

function createButtonInteraction() {
  const interaction = {
    id: '423456789012345678',
    nexusCommandName: 'verify',
    commandName: null,
    user: { id: USER_ID },
    guildId: GUILD_ID,
    deferred: false,
    edits: [],
    deferUpdate: async () => { interaction.deferred = true; },
    editReply: async (payload) => interaction.edits.push(payload),
    reply: async (payload) => interaction.edits.push(payload),
  };
  return interaction;
}

const sessions = () => new InteractionSessionStore({
  createToken: () => '11111111-2222-4333-8444-555555555555',
});

const customId = (message) => message.components[0].components[0].data.custom_id;

test('/verify rejects malformed codes before calling Nexus', async () => {
  const interaction = createVerifyInteraction('not-a-code');
  const apiService = {
    previewAccountLink: async () => assert.fail('invalid code should not call Nexus'),
  };

  await executeVerify(interaction, { logger: createLogger(), apiService, sessions: sessions() });

  assert.equal(interaction.replied, true);
  assert.equal(interaction.deferred, false);
  assert.equal(interaction.replies[0].ephemeral, true);
  assert.equal(embedJson(interaction.replies[0]).title, 'Verification Issue');
});

test('/verify previews then confirms an installation-bound Nexus account link', async () => {
  const interaction = createVerifyInteraction(`  ${CODE.toUpperCase()}  `);
  const store = sessions();
  const calls = [];
  const apiService = {
    previewAccountLink: async (actor, payload) => {
      calls.push({ method: 'preview', actor, payload });
      return {
        intent: {
          id: INTENT_ID,
          action: 'account.link',
          expires_at: '2026-08-08T12:15:00Z',
        },
        summary: {
          description: 'Confirm to link this Discord account to nation #9001.',
          nation: { id: 9001, name: 'Test Nation', leader_name: 'Test Leader' },
          replaces_existing_link: false,
        },
        warnings: [],
      };
    },
    confirmAccountLink: async (actor, payload) => {
      calls.push({ method: 'confirm', actor, payload });
      return {
        linked: true,
        discord_user_id: USER_ID,
        discord_username: 'Test Global',
        linked_at: '2026-08-08T12:00:00Z',
        nation: { id: 9001, name: 'Test Nation', leader_name: 'Test Leader' },
      };
    },
    verifyUser: async () => assert.fail('legacy direct verification must not be used'),
  };
  const context = { logger: createLogger(), apiService, sessions: store };

  await executeVerify(interaction, context);

  assert.deepEqual(interaction.deferPayload, { ephemeral: true });
  assert.deepEqual(calls[0].payload, {
    token: CODE,
    discord_username: 'Test Global',
  });
  assert.equal(calls[0].actor.discordUserId, USER_ID);
  assert.equal(calls[0].actor.discordInteractionId, interaction.id);
  assert.equal(embedJson(interaction.edits[0]).title, 'Review Nexus Account Link');

  const session = store.resolve(customId(interaction.edits[0]), USER_ID);
  assert.equal(session.commandName, 'verify');
  assert.equal(session.event, 'confirm');
  assert.deepEqual(session.state, { intentId: INTENT_ID });

  const buttonInteraction = createButtonInteraction();
  await confirmVerify(buttonInteraction, { ...context, session });

  assert.deepEqual(calls[1].payload, { intent_id: INTENT_ID });
  assert.equal(calls[1].actor.discordUserId, USER_ID);
  assert.equal(calls[1].actor.discordInteractionId, buttonInteraction.id);
  const success = embedJson(buttonInteraction.edits[0]);
  assert.equal(success.title, 'Nexus Account Linked');
  assert.match(success.description, /nation #9001/i);
  assert.deepEqual(buttonInteraction.edits[0].components, []);
});

test('/verify warns before replacing a different active link', async () => {
  const interaction = createVerifyInteraction();
  const store = sessions();
  const apiService = {
    previewAccountLink: async () => ({
      intent: { id: INTENT_ID, action: 'account.link' },
      summary: {
        description: 'Confirm this link.',
        nation: { id: 9001 },
        replaces_existing_link: true,
      },
      warnings: ['This Discord account is currently linked elsewhere.'],
    }),
  };

  await executeVerify(interaction, { logger: createLogger(), apiService, sessions: store });

  const warning = embedJson(interaction.edits[0]).fields.find((field) => field.name === 'Warning');
  assert.match(warning.value, /linked elsewhere/i);
});

test('/verify renders stale-code recovery guidance from Nexus', async () => {
  const interaction = createVerifyInteraction();
  const store = sessions();
  const apiService = {
    previewAccountLink: async () => ({
      intent: { id: INTENT_ID, action: 'account.link' },
      summary: { description: 'Confirm this link.', nation: null },
      warnings: [],
    }),
    confirmAccountLink: async () => {
      throw new ApiContractError('The verification code changed or was already used.', {
        code: 'verification_intent_stale',
        status: 409,
        details: { user_action: 'Get a fresh verification code from Nexus and run /verify again.' },
      });
    },
  };
  const context = { logger: createLogger(), apiService, sessions: store };
  await executeVerify(interaction, context);
  const session = store.resolve(customId(interaction.edits[0]), USER_ID);
  const buttonInteraction = createButtonInteraction();

  await confirmVerify(buttonInteraction, { ...context, session });

  const error = embedJson(buttonInteraction.edits[0]);
  assert.equal(error.title, 'Verification Failed');
  assert.match(error.description, /already used/i);
  assert.match(error.footer.text, /fresh verification code/i);
});
