import { SlashCommandBuilder } from 'discord.js';
import { config } from '../utils/config.js';
import { deferEphemeral } from '../utils/commandSupport.js';
import {
  escapeMarkdown, markdownLink, resolveDeepLink, statusMessage, truncate,
} from '../utils/discordUi.js';

/**
 * Topic labels and descriptions are presentation-only. Command membership is
 * declared by each command module's help metadata below its command data.
 */
const HELP_TOPICS = Object.freeze([
  Object.freeze({
    value: 'getting-started',
    name: 'Getting started',
    description: 'Link your account, check the bot, and find the right command.',
  }),
  Object.freeze({
    value: 'member',
    name: 'Member tools',
    description: 'Review your Nexus account, requests, audits, and support workflows.',
  }),
  Object.freeze({
    value: 'finance',
    name: 'Finance',
    description: 'Check accounts and submit or review finance requests.',
  }),
  Object.freeze({
    value: 'applications',
    name: 'Applications',
    description: 'Start, continue, review, and decide Nexus applications.',
  }),
  Object.freeze({
    value: 'military',
    name: 'Military',
    description: 'Review current military information and support requests.',
  }),
  Object.freeze({
    value: 'staff',
    name: 'Staff tools',
    description: 'Find staff-facing queues and management actions.',
  }),
  Object.freeze({
    value: 'uncategorized',
    name: 'Uncategorized',
    description: 'Loaded commands without recognized help metadata are shown here.',
  }),
]);

const HELP_TOPIC_BY_VALUE = Object.freeze(Object.fromEntries(
  HELP_TOPICS.map((topic) => [topic.value, topic]),
));

const GUIDE_PATH = '/user/discord-bot-guide';

const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_FIELD_VALUE = 1_024;
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

export const help = Object.freeze({
  audience: 'Everyone',
  topic: Object.freeze(['getting-started']),
  examples: Object.freeze(['/help', '/help command:war', '/help topic:finance']),
  related: Object.freeze(['ping', 'verify']),
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
    return {
      ...serialized,
      name,
      help: candidate?.help ?? candidate?.helpMetadata,
    };
  } catch {
    return null;
  }
};

/**
 * Resolve serialized command data and help metadata from loaded command
 * modules. The running bot exposes those modules on interaction.client.
 * Tests and other callers may provide the same collection through context.
 */
export const loadedCommandData = (interaction, context = {}) => {
  const sources = [interaction?.client?.commands, context.commands];
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

const metadataFor = (command) => {
  const metadata = command?.help;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
};

const topicValuesFor = (command) => {
  const topic = metadataFor(command).topic;
  const values = Array.isArray(topic) ? topic : [topic];
  return [...new Set(values
    .map(normalizedValue)
    .filter((value) => Boolean(HELP_TOPIC_BY_VALUE[value]) && value !== 'uncategorized'))];
};

const topicsFor = (command) => topicValuesFor(command).map((value) => HELP_TOPIC_BY_VALUE[value]);

const topicCommands = (topic, commands) => commands.filter((command) => {
  const values = topicValuesFor(command);
  return topic.value === 'uncategorized' ? values.length === 0 : values.includes(topic.value);
});

const availableTopics = (commands) => HELP_TOPICS.filter((topic) => topicCommands(topic, commands).length > 0);

const audienceFor = (command) => {
  const audience = metadataFor(command).audience;
  if (Array.isArray(audience)) return audience.filter(Boolean).join(', ') || 'Members and staff';
  return typeof audience === 'string' && audience.trim() ? audience : 'Members and staff';
};

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

const examplesFor = (command) => {
  const examples = metadataFor(command).examples;
  if (Array.isArray(examples)) {
    const usable = examples.filter((example) => typeof example === 'string' && example.trim());
    if (usable.length) return usable;
  }
  return usageFor(command).slice(0, 4);
};

const relatedFor = (command, commands) => {
  const available = new Set(commands.map(({ name }) => name));
  const related = metadataFor(command).related;
  const explicit = Array.isArray(related) ? related : [related];
  return [...new Set(explicit
    .filter((name) => typeof name === 'string')
    .map(normalizedValue)
    .filter((name) => name && name !== command.name && available.has(name)))]
    .slice(0, 6);
};

const capabilityAvailabilityFor = (command, context = {}) => {
  const capability = metadataFor(command).capability;
  if (typeof capability !== 'string' || !capability.trim()) return null;

  const source = context.capabilities
    ?? context.availableCapabilities
    ?? context.capabilityAvailability;
  if (source === undefined || source === null) return null;

  const availabilityValue = (value) => {
    if (typeof value === 'boolean') return value;
    if (value && typeof value === 'object' && typeof value.available === 'boolean') return value.available;
    return null;
  };

  if (typeof source === 'function') return availabilityValue(source(capability, command));
  if (source instanceof Set || Array.isArray(source)) return source.has?.(capability) ?? source.includes(capability);
  if (source instanceof Map) return source.has(capability) ? availabilityValue(source.get(capability)) : null;
  if (typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, capability)) {
    return availabilityValue(source[capability]);
  }
  return null;
};

const availabilityNoteFor = (command, context) => capabilityAvailabilityFor(command, context) === false
  ? 'Setup or upgrade may be required before this command is available. Nexus will confirm access when you run it.'
  : null;

const guideUrlFor = (context = {}) => resolveDeepLink(
  context.apiService?.baseUrl ?? context.nexusBaseUrl ?? config.nexusApi.baseUrl,
  GUIDE_PATH,
);

const guideText = (guideUrl) => markdownLink('Open the full Nexus Discord guide', guideUrl);

const commonFooter = 'Help metadata is for discoverability; Nexus enforces permissions and command availability.';

const fieldValue = (value, fallback = '—') => truncate(value, MAX_FIELD_VALUE, fallback);

const commandLabel = (command, context) => {
  const availabilityNote = availabilityNoteFor(command, context);
  return `/${command.name}${availabilityNote ? ' — setup or upgrade may be required' : ''}`;
};

const commandHelpMessage = (command, commands, context, topicValue = null) => {
  const guideUrl = guideUrlFor(context);
  const examples = examplesFor(command);
  const options = leafOptions(command.options ?? []);
  const related = relatedFor(command, commands);
  const topics = topicsFor(command).map(({ name }) => name).join(', ');
  const ignoredTopic = topicValue && !topicValuesFor(command).includes(topicValue)
    ? '\nThe topic filter was ignored because command help was requested.'
    : '';
  const availabilityNote = availabilityNoteFor(command, context);

  return statusMessage({
    title: `/${command.name}`,
    description: [
      escapeMarkdown(descriptionFor(command)),
      availabilityNote ? `\n${escapeMarkdown(availabilityNote)}` : null,
      '',
      guideText(guideUrl),
      ignoredTopic,
    ].filter(Boolean).join('\n'),
    fields: [
      { name: 'Audience', value: fieldValue(escapeMarkdown(audienceFor(command))), inline: true },
      { name: 'Topics', value: fieldValue(escapeMarkdown(topics || 'Uncategorized')), inline: true },
      { name: 'Usage', value: fieldValue(examples.map((example) => `\`${escapeMarkdown(example)}\``).join('\n')) },
      ...(options.length ? [{ name: 'Options and subcommands', value: fieldValue(options.join('\n')) }] : []),
      ...(related.length ? [{ name: 'Related commands', value: fieldValue(related.map((name) => `\`/${name}\``).join(' · ')) }] : []),
    ],
    footer: commonFooter,
    url: guideUrl,
  });
};

const topicAudience = (topic, commands) => {
  const audiences = [...new Set(topicCommands(topic, commands).map(audienceFor))];
  return audiences.length ? audiences.join(', ') : 'Members and staff';
};

const topicHelpMessage = (topic, commands, context) => {
  const guideUrl = guideUrlFor(context);
  const listed = topicCommands(topic, commands);
  const commandLines = listed.length
    ? listed.map((command) => `\`${commandLabel(command, context)}\` — ${escapeMarkdown(descriptionFor(command))}`).join('\n')
    : 'No loaded commands are currently associated with this topic.';

  return statusMessage({
    title: topic.name,
    description: [escapeMarkdown(topic.description), '', guideText(guideUrl)].join('\n'),
    fields: [
      { name: 'Audience', value: fieldValue(escapeMarkdown(topicAudience(topic, commands)), 'Members and staff'), inline: true },
      { name: 'Commands', value: fieldValue(commandLines, 'No loaded commands are currently associated with this topic.') },
    ],
    footer: commonFooter,
    url: guideUrl,
  });
};

const overviewMessage = (commands, context) => {
  const guideUrl = guideUrlFor(context);
  const fields = HELP_TOPICS
    .map((topic) => {
      const listed = topicCommands(topic, commands);
      if (!listed.length) return null;
      return {
        name: topic.name,
        value: fieldValue(listed.map((command) => `\`${commandLabel(command, context)}\``).join(' · ')),
      };
    })
    .filter(Boolean);

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
    ? availableTopics(commands)
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
  const topic = topicName
    ? HELP_TOPICS.find(({ value, name }) => normalizedValue(value) === topicName || normalizedValue(name) === topicName)
    : null;

  let payload;
  if (commandValue && !command) {
    payload = notFoundMessage('command', commandValue, commands.map(({ name }) => `/${name}`), context);
  } else if (!commandValue && topicValue && !topic) {
    payload = notFoundMessage('topic', topicValue, availableTopics(commands).map(({ value }) => value), context);
  } else if (command) {
    payload = commandHelpMessage(command, commands, context, topic?.value ?? (topicValue ? topicName : null));
  } else if (topic) {
    payload = topicHelpMessage(topic, commands, context);
  } else {
    payload = overviewMessage(commands, context);
  }

  await interaction.editReply(payload);
};
