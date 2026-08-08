import { SlashCommandBuilder } from 'discord.js';
import { config } from '../utils/config.js';
import { deferEphemeral } from '../utils/commandSupport.js';
import {
  escapeMarkdown, markdownLink, resolveDeepLink, statusMessage, truncate,
} from '../utils/discordUi.js';

/**
 * Discoverability metadata for /help.
 *
 * This catalog is intentionally not an authorization map. Nexus remains the
 * source of truth for whether a member may execute a command.
 */
const HELP_TOPICS = Object.freeze([
  Object.freeze({
    value: 'getting-started',
    name: 'Getting started',
    description: 'Link your account, check the bot, and find the right command.',
    audience: 'Everyone',
    commands: ['help', 'ping', 'verify'],
  }),
  Object.freeze({
    value: 'member',
    name: 'Member tools',
    description: 'Review your Nexus account, requests, audits, and support workflows.',
    audience: 'Members',
    commands: [
      'accounts', 'alerts', 'audit', 'deposit', 'grant', 'loan', 'raid', 'rebuild',
      'requests', 'spy', 'transactions', 'unblockade', 'war', 'waraid', 'withdraw',
    ],
  }),
  Object.freeze({
    value: 'finance',
    name: 'Finance',
    description: 'Check accounts and submit or review finance requests.',
    audience: 'Members and finance staff',
    commands: ['accounts', 'deposit', 'grant', 'loan', 'sweepbank', 'transactions', 'withdraw'],
  }),
  Object.freeze({
    value: 'applications',
    name: 'Applications',
    description: 'Start, continue, review, and decide Nexus applications.',
    audience: 'Applicants and application staff',
    commands: ['apply', 'applications', 'approve', 'deny'],
  }),
  Object.freeze({
    value: 'military',
    name: 'Military',
    description: 'Review current military information and support requests.',
    audience: 'Members and military staff',
    commands: ['raid', 'spy', 'unblockade', 'war', 'waraid'],
  }),
  Object.freeze({
    value: 'staff',
    name: 'Staff tools',
    description: 'Find staff-facing queues and management actions.',
    audience: 'Staff',
    commands: ['applications', 'approve', 'audit', 'deny', 'raid', 'requests', 'sweepbank'],
  }),
]);

/**
 * Command-specific guidance that is difficult to infer from SlashCommandBuilder.
 * Descriptions and option details are always read from the loaded command data.
 */
const COMMAND_HELP = Object.freeze({
  help: Object.freeze({
    audience: 'Everyone',
    examples: ['/help', '/help command:war', '/help topic:finance'],
    related: ['ping', 'verify'],
  }),
  applications: Object.freeze({
    examples: ['/applications status', '/applications review'],
    related: ['apply', 'approve', 'deny'],
  }),
  audit: Object.freeze({
    examples: ['/audit status', '/audit acknowledge'],
    related: ['requests', 'help'],
  }),
  alerts: Object.freeze({
    examples: ['/alerts list', '/alerts nation'],
    related: ['war', 'audit'],
  }),
  war: Object.freeze({
    examples: ['/war active', '/war counter', '/war simulate'],
    related: ['raid', 'spy', 'waraid'],
  }),
});

const GUIDE_PATH = '/user/discord-bot-guide';

const MAX_AUTOCOMPLETE_CHOICES = 25;
const OPTION_TYPES = Object.freeze({
  1: 'subcommand',
  2: 'subcommand group',
  3: 'text',
  4: 'integer',
  5: 'yes/no',
  6: 'user',
  7: 'channel',
  8: 'role',
  9: 'mentionable',
  10: 'number',
  11: 'attachment',
});

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Find Nexus Discord commands and learn how to use them.')
  .addStringOption((option) => option
    .setName('command')
    .setDescription('The command to learn about.')
    .setAutocomplete(true))
  .addStringOption((option) => option
    .setName('topic')
    .setDescription('Show commands in a topic.')
    .setAutocomplete(true))
  .setDMPermission(false);

const valueList = (source) => {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (typeof source.values === 'function') return Array.from(source.values());
  if (typeof source === 'object') return Object.values(source);
  return [];
};

const serializeCommand = (candidate) => {
  const dataCandidate = candidate?.data ?? candidate;
  if (!dataCandidate) return null;

  try {
    const serialized = typeof dataCandidate.toJSON === 'function'
      ? dataCandidate.toJSON()
      : dataCandidate;
    const name = typeof serialized?.name === 'string' ? serialized.name.trim().toLowerCase() : '';
    if (!name) return null;
    return { ...serialized, name };
  } catch {
    return null;
  }
};

/**
 * Resolve the loaded command metadata without importing the command loader.
 * The running bot exposes its Collection on interaction.client; tests and
 * other callers may provide commands or commandData in the execution context.
 */
export const loadedCommandData = (interaction, context = {}) => {
  const sources = [
    context.commands,
    interaction?.client?.commands,
    context.commandData,
    interaction?.client?.commandData,
  ];
  const commands = new Map();

  for (const source of sources) {
    for (const candidate of valueList(source)) {
      const serialized = serializeCommand(candidate);
      if (serialized && !commands.has(serialized.name)) commands.set(serialized.name, serialized);
    }
  }

  return Array.from(commands.values());
};

const normalizedValue = (value) => String(value ?? '').trim().toLowerCase().replace(/^\//, '');

const topicFor = (commandName) => HELP_TOPICS.filter((topic) => topic.commands.includes(commandName));

const metadataFor = (commandName) => COMMAND_HELP[commandName] ?? {};

const audienceFor = (command) => metadataFor(command.name).audience
  ?? topicFor(command.name)[0]?.audience
  ?? 'Members and staff';

const descriptionFor = (command) => command.description || 'No description is available for this command yet.';

const optionDescription = (option) => {
  const type = OPTION_TYPES[option.type] ?? 'value';
  const required = option.required ? 'required' : 'optional';
  const choices = Array.isArray(option.choices) && option.choices.length
    ? ` Choices: ${option.choices.slice(0, 8).map((choice) => choice.name ?? choice.value).join(', ')}.`
    : '';
  return `\`${option.name}\` · ${type} · ${required} — ${option.description || 'No description.'}${choices}`;
};

const leafOptions = (options = [], prefix = []) => options.flatMap((option) => {
  const path = [...prefix, option.name];
  if ((option.type === 1 || option.type === 2) && Array.isArray(option.options)) {
    return [
      ...((option.type === 2) ? [] : [
        `\`/${path.join(' ')}\` — ${option.description || 'No description.'}`,
      ]),
      ...leafOptions(option.options, path),
    ];
  }
  return [optionDescription({ ...option, name: path.join(' ') })];
});

const usageParts = (options = []) => options.flatMap((option) => {
  if (option.type === 1) {
    const nested = usageParts(option.options);
    return nested.length ? [`${option.name}${nested[0] ? ` ${nested[0]}` : ''}`] : [option.name];
  }
  if (option.type === 2) {
    const nested = option.options?.flatMap((child) => usageParts([child])) ?? [];
    return nested.length ? nested.map((value) => `${option.name} ${value}`) : [option.name];
  }
  return [`${option.required ? '' : '['}${option.name}:<value>${option.required ? '' : ']'}`];
});

const usageFor = (command) => {
  const parts = usageParts(command.options ?? []);
  if (!parts.length) return [`/${command.name}`];
  if ((command.options ?? []).some((option) => option.type === 1 || option.type === 2)) {
    return parts.slice(0, 8).map((part) => `/${command.name} ${part}`);
  }
  return [`/${command.name} ${parts.join(' ')}`];
};

const relatedFor = (command, commands) => {
  const available = new Set(commands.map(({ name }) => name));
  const explicit = metadataFor(command.name).related ?? [];
  const sameTopic = topicFor(command.name)
    .flatMap((topic) => topic.commands)
    .filter((name) => name !== command.name);
  return [...new Set([...explicit, ...sameTopic])]
    .filter((name) => available.has(name))
    .slice(0, 6);
};

const guideUrlFor = (context = {}) => resolveDeepLink(
  context.apiService?.baseUrl ?? context.nexusBaseUrl ?? config.nexusApi.baseUrl,
  GUIDE_PATH,
);

const guideText = (guideUrl) => markdownLink('Open the full Nexus Discord guide', guideUrl);

const commonFooter = 'Help metadata is for discoverability; Nexus enforces permissions and command availability.';

const commandHelpMessage = (command, commands, context, topicValue = null) => {
  const guideUrl = guideUrlFor(context);
  const metadata = metadataFor(command.name);
  const examples = metadata.examples?.length ? metadata.examples : usageFor(command).slice(0, 4);
  const options = leafOptions(command.options ?? []);
  const related = relatedFor(command, commands);
  const topics = topicFor(command.name).map(({ name }) => name).join(', ');
  const ignoredTopic = topicValue && !topicFor(command.name).some(({ value }) => value === topicValue)
    ? `\nThe topic filter was ignored because command help was requested.`
    : '';

  return statusMessage({
    title: `/${command.name}`,
    description: [
      escapeMarkdown(descriptionFor(command)),
      '',
      guideText(guideUrl),
      ignoredTopic,
    ].filter(Boolean).join('\n'),
    fields: [
      { name: 'Audience', value: escapeMarkdown(audienceFor(command)), inline: true },
      { name: 'Topics', value: escapeMarkdown(topics || 'General'), inline: true },
      { name: 'Usage', value: examples.map((example) => `\`${escapeMarkdown(example)}\``).join('\n') },
      ...(options.length ? [{ name: 'Options and subcommands', value: options.join('\n') }] : []),
      ...(related.length ? [{ name: 'Related commands', value: related.map((name) => `\`/${name}\``).join(' · ') }] : []),
    ],
    footer: commonFooter,
    url: guideUrl,
  });
};

const topicHelpMessage = (topic, commands, context) => {
  const guideUrl = guideUrlFor(context);
  const available = new Map(commands.map((command) => [command.name, command]));
  const listed = topic.commands
    .map((name) => available.get(name))
    .filter(Boolean);
  const commandLines = listed.length
    ? listed.map((command) => `\`/${command.name}\` — ${escapeMarkdown(descriptionFor(command))}`).join('\n')
    : 'No loaded commands are currently associated with this topic.';

  return statusMessage({
    title: topic.name,
    description: [escapeMarkdown(topic.description), '', guideText(guideUrl)].join('\n'),
    fields: [
      { name: 'Audience', value: escapeMarkdown(topic.audience), inline: true },
      { name: 'Commands', value: commandLines },
    ],
    footer: commonFooter,
    url: guideUrl,
  });
};

const overviewMessage = (commands, context) => {
  const guideUrl = guideUrlFor(context);
  const available = new Set(commands.map(({ name }) => name));
  const fields = HELP_TOPICS
    .map((topic) => {
      const names = topic.commands.filter((name) => available.has(name));
      if (!names.length) return null;
      return {
        name: topic.name,
        value: names.map((name) => `\`/${name}\``).join(' · '),
      };
    })
    .filter(Boolean);
  const categorized = new Set(HELP_TOPICS.flatMap((topic) => topic.commands));
  const other = commands.filter(({ name }) => !categorized.has(name)).map(({ name }) => `\`/${name}\``);
  if (other.length) fields.push({ name: 'Other loaded commands', value: other.join(' · ') });

  return statusMessage({
    title: 'Nexus Discord Help',
    description: [
      'Choose a command to see its inferred usage and options, or choose a topic to browse related commands.',
      '',
      guideText(guideUrl),
    ].join('\n'),
    fields: fields.length ? fields : [{ name: 'Commands', value: 'No loaded command metadata is available. Run this again after the bot finishes loading.' }],
    footer: commonFooter,
    url: guideUrl,
  });
};

const notFoundMessage = (kind, value, suggestions, context) => {
  const guideUrl = guideUrlFor(context);
  const available = suggestions.length
    ? `Available ${kind}s include: ${suggestions.slice(0, 12).map((suggestion) => `\`${suggestion}\``).join(' · ')}.`
    : `No loaded ${kind}s are available right now.`;
  return statusMessage({
    title: `${kind[0].toUpperCase()}${kind.slice(1)} Not Found`,
    tone: 'warning',
    description: [
      `I couldn't find ${kind === 'command' ? `\`/${escapeMarkdown(value)}\`` : `the \`${escapeMarkdown(value)}\` topic`}.`,
      'The choice may be stale. Run `/help` again and use autocomplete for current choices.',
      available,
      guideText(guideUrl),
    ].join('\n'),
    footer: commonFooter,
    url: guideUrl,
  });
};

export const autocomplete = async (interaction, context = {}) => {
  const focused = interaction.options?.getFocused?.(true) ?? {};
  const query = normalizedValue(focused.value);
  const commands = loadedCommandData(interaction, context);
  const choices = focused.name === 'topic'
    ? HELP_TOPICS
      .filter((topic) => commands.length === 0 || topic.commands.some((name) => commands.some((command) => command.name === name)))
      .filter((topic) => !query || `${topic.value} ${topic.name} ${topic.description}`.toLowerCase().includes(query))
      .map((topic) => ({ name: topic.name, value: topic.value }))
    : focused.name === 'command'
      ? commands
        .filter((command) => !query || `${command.name} ${descriptionFor(command)}`.toLowerCase().includes(query))
        .map((command) => ({
          name: truncate(`/${command.name} — ${descriptionFor(command)}`, 100),
          value: command.name,
        }))
      : [];

  await interaction.respond(choices.slice(0, MAX_AUTOCOMPLETE_CHOICES));
};

export const execute = async (interaction, context = {}) => {
  await deferEphemeral(interaction);
  const commands = loadedCommandData(interaction, context);
  const commandValue = interaction.options?.getString?.('command') ?? null;
  const topicValue = interaction.options?.getString?.('topic') ?? null;
  const commandName = normalizedValue(commandValue);
  const topicName = normalizedValue(topicValue);
  const command = commandName ? commands.find(({ name }) => name === commandName) : null;
  const topic = topicName ? HELP_TOPICS.find(({ value, name }) => normalizedValue(value) === topicName || normalizedValue(name) === topicName) : null;

  let payload;
  if (commandValue && !command) {
    payload = notFoundMessage('command', commandValue, commands.map(({ name }) => `/${name}`), context);
  } else if (!commandValue && topicValue && !topic) {
    payload = notFoundMessage('topic', topicValue, HELP_TOPICS.map(({ value }) => value), context);
  } else if (command) {
    payload = commandHelpMessage(command, commands, context, topic?.value ?? null);
  } else if (topic) {
    payload = topicHelpMessage(topic, commands, context);
  } else {
    payload = overviewMessage(commands, context);
  }

  await interaction.editReply(payload);
};
