import test from 'node:test';
import assert from 'node:assert/strict';
import { SlashCommandBuilder } from 'discord.js';
import { autocomplete, data, execute, loadedCommandData } from '../src/commands/help.js';
import { embedJson } from './helpers.js';

const helpMetadata = ({
  audience = 'Members',
  topic = 'member',
  examples = [`/${topic}`],
  related = [],
  capability,
} = {}) => Object.freeze({
  audience,
  topic: Object.freeze(Array.isArray(topic) ? topic : [topic]),
  examples: Object.freeze(examples),
  related: Object.freeze(related),
  ...(capability ? { capability } : {}),
});

const command = (name, description, addOptions = () => {}, help) => {
  const builder = new SlashCommandBuilder().setName(name).setDescription(description);
  addOptions(builder);
  return { data: builder, help, execute: async () => {} };
};

const makeInteraction = ({ values = {}, focused = {}, client, commandData } = {}) => {
  const replies = [];
  const responses = [];
  return {
    client,
    commandData,
    options: {
      getString: (name) => values[name] ?? null,
      getFocused: () => focused,
    },
    deferReply: async (payload) => {
      assert.equal(payload.ephemeral, true);
    },
    editReply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    respond: async (choices) => {
      responses.push(choices);
    },
    replies,
    responses,
  };
};

test('/help is guild-only and exposes autocomplete command/topic options', () => {
  const serialized = data.toJSON();
  assert.equal(serialized.name, 'help');
  assert.equal(serialized.dm_permission, false);
  assert.deepEqual(serialized.options.map((option) => [option.name, option.autocomplete]), [
    ['command', true],
    ['topic', true],
  ]);
});

test('loadedCommandData reads command builders from the loaded collection', () => {
  const warHelp = helpMetadata({ topic: 'military', examples: ['/war active'], related: ['ping'] });
  const commands = new Map([
    ['war', command('war', 'Review active wars.', (builder) => builder.addSubcommand((subcommand) => subcommand
      .setName('active').setDescription('List active wars.')), warHelp)],
    ['ping', command('ping', 'Check the bot.')],
  ]);

  const loaded = loadedCommandData({ client: { commands }, commandData: [{ name: 'phantom' }] }, {});
  assert.deepEqual(loaded.map(({ name }) => name), ['war', 'ping']);
  assert.equal(loaded[0].options[0].name, 'active');
  assert.equal(loaded[0].help, warHelp);
});

test('/help command renders inferred description/options and the configured guide link', async () => {
  const commands = new Map([
    ['war', command('war', 'Review active wars.', (builder) => builder.addSubcommand((subcommand) => subcommand
      .setName('active').setDescription('List active wars.')), helpMetadata({
        audience: 'Members and military staff', topic: 'military', examples: ['/war active'], related: ['raid'],
      }))],
    ['raid', command('raid', 'Review raid targets.', () => {}, helpMetadata({ topic: 'military' }))],
  ]);
  const interaction = makeInteraction({
    values: { command: 'war' },
    client: { commands },
  });

  await execute(interaction, { apiService: { baseUrl: 'https://nexus.example/' } });

  const embed = embedJson(interaction.replies[0]);
  assert.equal(embed.title, '/war');
  assert.equal(embed.url, 'https://nexus.example/user/discord-bot-guide');
  assert.match(embed.description, /Review active wars/);
  assert.match(embed.description, /discord-bot-guide/);
  assert.match(embed.fields.find(({ name }) => name === 'Options and subcommands').value, /active/);
  assert.match(embed.fields.find(({ name }) => name === 'Usage').value, /\/war active/);
  assert.match(embed.fields.find(({ name }) => name === 'Related commands').value, /\/raid/);
});

test('/help defaults to a categorized ephemeral overview', async () => {
  const commands = new Map([
    ['accounts', command('accounts', 'Review accounts.', () => {}, helpMetadata({ topic: ['member', 'finance'] }))],
    ['ping', command('ping', 'Check the bot.', () => {}, helpMetadata({ audience: 'Everyone', topic: 'getting-started' }))],
  ]);
  const interaction = makeInteraction({ client: { commands } });

  await execute(interaction, {});

  const embed = embedJson(interaction.replies[0]);
  assert.equal(embed.title, 'Nexus Discord Help');
  assert.match(embed.fields.find(({ name }) => name === 'Member tools').value, /\/accounts/);
  assert.match(embed.fields.find(({ name }) => name === 'Getting started').value, /\/ping/);
});

test('/help topic lists only loaded commands', async () => {
  const commands = new Map([
    ['accounts', command('accounts', 'Review accounts.', () => {}, helpMetadata({ topic: 'finance' }))],
    ['withdraw', command('withdraw', 'Request a withdrawal.', () => {}, helpMetadata({ topic: 'finance' }))],
  ]);
  const interaction = makeInteraction({ values: { topic: 'finance' }, client: { commands } });

  await execute(interaction, {});

  const embed = embedJson(interaction.replies[0]);
  assert.equal(embed.title, 'Finance');
  assert.match(embed.fields.find(({ name }) => name === 'Commands').value, /\/accounts/);
  assert.match(embed.fields.find(({ name }) => name === 'Commands').value, /\/withdraw/);
  assert.doesNotMatch(embed.fields.find(({ name }) => name === 'Commands').value, /\/loan/);
});

test('/help autocomplete uses loaded commands/topics and caps results', async () => {
  const commands = new Map(Array.from({ length: 30 }, (_, index) => {
    const name = `cmd${String(index).padStart(2, '0')}`;
    return [name, command(name, `Command ${index}.`)];
  }));
  const commandInteraction = makeInteraction({
    focused: { name: 'command', value: 'cmd' },
    client: { commands },
  });
  await autocomplete(commandInteraction, {});
  assert.equal(commandInteraction.responses[0].length, 25);
  assert.equal(commandInteraction.responses[0][0].value, 'cmd00');

  const topicCommands = new Map(commands);
  topicCommands.set('accounts', command('accounts', 'Review account balances.', () => {}, helpMetadata({ topic: 'finance' })));
  const topicInteraction = makeInteraction({ focused: { name: 'topic', value: 'fin' }, client: { commands: topicCommands } });
  await autocomplete(topicInteraction, {});
  assert.deepEqual(topicInteraction.responses[0], [{ name: 'Finance', value: 'finance' }]);
});

test('/help puts metadata-free loaded modules in an uncategorized fallback', async () => {
  const commands = new Map([
    ['custom', command('custom', 'A command added by another branch.')],
    ['ping', command('ping', 'Check the bot.', () => {}, helpMetadata({ audience: 'Everyone', topic: 'getting-started' }))],
  ]);
  const interaction = makeInteraction({ client: { commands } });

  await execute(interaction, {});

  const embed = embedJson(interaction.replies[0]);
  assert.match(embed.fields.find(({ name }) => name === 'Uncategorized').value, /\/custom/);
  assert.doesNotMatch(embed.fields.find(({ name }) => name === 'Getting started').value, /\/custom/);
});

test('/help shows explicit capability setup guidance without hiding the loaded command', async () => {
  const commands = new Map([
    ['premium', command('premium', 'Use a premium command.', () => {}, helpMetadata({
      topic: 'member', capability: 'premium.command', examples: ['/premium'],
    }))],
  ]);
  const interaction = makeInteraction({ values: { command: 'premium' }, client: { commands } });

  await execute(interaction, { capabilities: { 'premium.command': false } });

  const embed = embedJson(interaction.replies[0]);
  assert.match(embed.description, /setup or upgrade/i);
  assert.match(embed.footer.text, /discoverability/);
});

test('/help gives a useful response for stale command and topic choices', async () => {
  const commandInteraction = makeInteraction({ values: { command: 'removed' }, client: { commands: new Map() } });
  await execute(commandInteraction, { apiService: { baseUrl: 'https://nexus.example' } });
  assert.match(embedJson(commandInteraction.replies[0]).description, /choice may be stale/);
  assert.match(embedJson(commandInteraction.replies[0]).description, /discord-bot-guide/);

  const topicInteraction = makeInteraction({ values: { topic: 'removed-topic' }, client: { commands: new Map() } });
  await execute(topicInteraction, {});
  assert.match(embedJson(topicInteraction.replies[0]).description, /removed\\-topic/);
  assert.match(embedJson(topicInteraction.replies[0]).description, /autocomplete/);
});
