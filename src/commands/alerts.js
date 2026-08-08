import { SlashCommandBuilder } from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  escapeMarkdown, formatNumber, statusMessage, truncate,
} from '../utils/discordUi.js';

const NATION_EVENTS = [
  ['Alliance changed', 'alliance_changed'],
  ['Entered vacation mode', 'vacation_mode_entered'],
  ['Exited vacation mode', 'vacation_mode_exited'],
  ['Exited beige', 'beige_exited'],
  ['City count changed', 'city_count_changed'],
  ['Active war count changed', 'war_state_changed'],
];
const ALLIANCE_EVENTS = [
  ['Membership changed', 'membership_changed'],
  ['Treaty changed', 'treaty_changed'],
];
const RESOURCES = ['coal', 'oil', 'uranium', 'iron', 'bauxite', 'lead', 'gasoline', 'munitions', 'steel', 'aluminum', 'food', 'credits'];

const addCommonOptions = (subcommand) => subcommand
  .addStringOption((option) => option.setName('name').setDescription('Optional label').setMaxLength(100))
  .addIntegerOption((option) => option.setName('cooldown').setDescription('Minutes between alerts').setMinValue(5).setMaxValue(10080));

export const data = new SlashCommandBuilder()
  .setName('alerts')
  .setDescription('Manage private Nexus alerts and watchlists.')
  .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List your alerts.'))
  .addSubcommand((subcommand) => addCommonOptions(subcommand
    .setName('nation')
    .setDescription('Watch one nation event.')
    .addIntegerOption((option) => option.setName('nation').setDescription('Politics & War nation ID').setRequired(true).setMinValue(1))
    .addStringOption((option) => {
      const event = option.setName('event').setDescription('Event to watch').setRequired(true);
      NATION_EVENTS.forEach(([name, value]) => event.addChoices({ name, value }));
      return event;
    })))
  .addSubcommand((subcommand) => addCommonOptions(subcommand
    .setName('alliance')
    .setDescription('Watch one alliance event.')
    .addIntegerOption((option) => option.setName('alliance').setDescription('Politics & War alliance ID').setRequired(true).setMinValue(1))
    .addStringOption((option) => {
      const event = option.setName('event').setDescription('Event to watch').setRequired(true);
      ALLIANCE_EVENTS.forEach(([name, value]) => event.addChoices({ name, value }));
      return event;
    })))
  .addSubcommand((subcommand) => addCommonOptions(subcommand
    .setName('market')
    .setDescription('Alert when a market price crosses a threshold.')
    .addStringOption((option) => {
      const resource = option.setName('resource').setDescription('Resource').setRequired(true);
      RESOURCES.forEach((value) => resource.addChoices({ name: value, value }));
      return resource;
    })
    .addStringOption((option) => option.setName('direction').setDescription('Threshold direction').setRequired(true).addChoices(
      { name: 'At or above', value: 'above' },
      { name: 'At or below', value: 'below' },
    ))
    .addNumberOption((option) => option.setName('price').setDescription('Price threshold').setRequired(true).setMinValue(0.01).setMaxValue(1000000000))))
  .addSubcommand((subcommand) => subcommand
    .setName('manage')
    .setDescription('Pause, resume, test, or delete an alert.')
    .addIntegerOption((option) => option.setName('id').setDescription('Alert ID from /alerts list').setRequired(true).setMinValue(1))
    .addStringOption((option) => option.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Pause', value: 'pause' },
      { name: 'Resume', value: 'resume' },
      { name: 'Test', value: 'test' },
      { name: 'Delete', value: 'delete' },
    )))
  .setDMPermission(false);

const createPayload = (interaction, subcommand) => {
  const common = {
    name: interaction.options.getString('name') ?? undefined,
    cooldown_minutes: interaction.options.getInteger('cooldown') ?? 60,
  };
  if (subcommand === 'nation') {
    return {
      ...common,
      type: 'nation',
      target_id: interaction.options.getInteger('nation'),
      events: [interaction.options.getString('event')],
    };
  }
  if (subcommand === 'alliance') {
    return {
      ...common,
      type: 'alliance',
      target_id: interaction.options.getInteger('alliance'),
      events: [interaction.options.getString('event')],
    };
  }
  return {
    ...common,
    type: 'market',
    resource: interaction.options.getString('resource'),
    direction: interaction.options.getString('direction'),
    threshold: interaction.options.getNumber('price'),
  };
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'list') {
      const alerts = await context.apiService.getMyAlerts(actor);
      await interaction.editReply(collectionMessage({
        title: 'Your Nexus Alerts',
        collection: normalizeCollection(alerts?.alerts ?? alerts),
        empty: 'You have no custom alerts. Use `/alerts nation`, `/alerts alliance`, or `/alerts market` to create one.',
        commandName: 'alerts',
        userId: interaction.user.id,
        sessions: context.sessions,
        variant: 'alert',
        description: 'Private alerts and watchlists configured for your linked Nexus account.',
        baseUrl: context.apiService.baseUrl,
        pageSize: 4,
      }));
      return;
    }

    if (subcommand === 'manage') {
      const id = interaction.options.getInteger('id');
      const action = interaction.options.getString('action');
      if (action === 'delete') {
        await context.apiService.deleteAlert(actor, id);
      } else if (action === 'test') {
        await context.apiService.testAlert(actor, id);
      } else {
        await context.apiService.updateAlertStatus(actor, id, action === 'resume');
      }
      const resultLabel = { pause: 'paused', resume: 'resumed', test: 'tested', delete: 'deleted' }[action];
      const title = {
        pause: 'Alert Paused', resume: 'Alert Resumed', test: 'Alert Test Sent', delete: 'Alert Deleted',
      }[action];
      await interaction.editReply(statusMessage({
        title,
        tone: ['pause', 'delete'].includes(action) ? 'warning' : 'success',
        description: `Alert **#${formatNumber(id, { maximumFractionDigits: 0 })}** was ${resultLabel}.`,
        footer: action === 'test' ? 'Check your Discord notifications for the test alert.' : 'Your alert settings are synced with Nexus.',
      }));
      return;
    }

    const created = await context.apiService.createAlert(
      actor,
      createPayload(interaction, subcommand),
    );
    const name = escapeMarkdown(truncate(created?.name ?? 'New alert', 100));
    await interaction.editReply(statusMessage({
      title: 'Alert Created',
      tone: 'success',
      description: `Created alert **#${formatNumber(created?.id, { maximumFractionDigits: 0 })} · ${name}**.`,
      footer: 'Nexus will establish a baseline before sending notifications.',
    }));
  } catch (error) {
    await replyError(interaction, error, 'Alert Request Failed');
  }
};
