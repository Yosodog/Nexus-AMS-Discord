import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder,
} from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  escapeMarkdown, formatDiscordTime, formatNumber, statusMessage, titleCase,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder()
  .setName('unblockade')
  .setDescription('Coordinate alliance blockade relief.')
  .addSubcommand((sub) => sub.setName('request').setDescription('Request help breaking an active blockade.')
    .addIntegerOption((option) => option.setName('war').setDescription('Active war ID').setRequired(true).setMinValue(1))
    .addIntegerOption((option) => option.setName('deadline').setDescription('Hours until this request expires')
      .addChoices(
        { name: '2 hours', value: 2 }, { name: '4 hours', value: 4 }, { name: '6 hours', value: 6 },
        { name: '12 hours', value: 12 }, { name: '24 hours', value: 24 },
      ))
    .addStringOption((option) => option.setName('note').setDescription('Optional coordination context').setMaxLength(255)))
  .addSubcommand((sub) => sub.setName('mine').setDescription('View your blockade relief requests.'))
  .addSubcommand((sub) => sub.setName('available').setDescription('View relief requests you can currently claim.'))
  .addSubcommand((sub) => sub.setName('claim').setDescription('Claim an eligible relief request.')
    .addIntegerOption((option) => option.setName('request').setDescription('Relief request ID').setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub.setName('cancel').setDescription('Cancel one of your active relief requests.')
    .addIntegerOption((option) => option.setName('request').setDescription('Relief request ID').setRequired(true).setMinValue(1)))
  .setDMPermission(false);

const requestCollection = (result) => normalizeCollection(result?.requests ?? result);

const actionCopy = {
  request: {
    title: 'Confirm Relief Request',
    description: 'Open a request asking eligible alliance members to help break this blockade.',
    label: 'Open request',
    style: ButtonStyle.Success,
  },
  claim: {
    title: 'Confirm Relief Claim',
    description: 'Claim this request and tell the requester that your nation intends to help.',
    label: 'Claim request',
    style: ButtonStyle.Success,
  },
  cancel: {
    title: 'Confirm Relief Cancellation',
    description: 'Cancel this open request so alliance members no longer act on it.',
    label: 'Cancel request',
    style: ButtonStyle.Danger,
  },
};

const confirmationMessage = (action, state, confirmId, cancelId) => {
  const copy = actionCopy[action];
  const fields = action === 'request'
    ? [
      { name: 'War', value: `#${formatNumber(state.body.war_id, { maximumFractionDigits: 0 })}`, inline: true },
      { name: 'Expires after', value: `${state.body.deadline_hours} hours`, inline: true },
      state.body.note ? { name: 'Coordination note', value: escapeMarkdown(state.body.note) } : null,
    ]
    : [{ name: 'Relief request', value: `#${formatNumber(state.id, { maximumFractionDigits: 0 })}` }];

  return statusMessage({
    title: copy.title,
    tone: 'warning',
    description: copy.description,
    fields,
    footer: 'Nexus will revalidate the live war, request state, identity, and permissions when you confirm.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel(copy.label).setStyle(copy.style),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Go back').setStyle(ButtonStyle.Secondary),
    )],
  });
};

const mutationResultMessage = (action, result) => {
  if (action === 'request') {
    return statusMessage({
      title: 'Relief Request Opened',
      tone: 'success',
      description: `Request **#${formatNumber(result?.id, { maximumFractionDigits: 0 })}** is open until ${formatDiscordTime(result?.deadline_at)}.`,
      footer: 'Alliance members who can break the blockade may now claim this request.',
    });
  }

  const status = escapeMarkdown(titleCase(result?.status ?? 'updated'));
  return statusMessage({
    title: action === 'claim' ? 'Relief Request Claimed' : 'Relief Request Cancelled',
    tone: action === 'claim' ? 'success' : 'warning',
    description: `Request **#${formatNumber(result?.id, { maximumFractionDigits: 0 })}** is now **${status}**.`,
    footer: 'Recheck the live war state in Nexus before acting.',
  });
};

const prepareConfirmation = async (interaction, context, action, state) => {
  const confirmId = context.sessions.create({
    commandName: 'unblockade',
    userId: interaction.user.id,
    event: `confirm-${action}`,
    state: { action, ...state },
    oneShot: true,
  });
  const cancelId = context.sessions.create({
    commandName: 'unblockade',
    userId: interaction.user.id,
    event: 'cancel',
    state: {},
    oneShot: true,
  });
  await interaction.editReply(confirmationMessage(action, state, confirmId, cancelId));
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'request') {
      await prepareConfirmation(interaction, context, 'request', { body: {
        war_id: interaction.options.getInteger('war', true),
        deadline_hours: interaction.options.getInteger('deadline') ?? 6,
        note: interaction.options.getString('note')?.trim() || null,
      } });
      return;
    }

    if (subcommand === 'claim' || subcommand === 'cancel') {
      await prepareConfirmation(interaction, context, subcommand, {
        id: interaction.options.getInteger('request', true),
      });
      return;
    }

    const actor = actorFromInteraction(interaction);
    const result = subcommand === 'available'
      ? await context.apiService.getAvailableBlockadeReliefRequests(actor)
      : await context.apiService.getMyBlockadeReliefRequests(actor);
    const collection = requestCollection(result);
    await interaction.editReply(collectionMessage({
      title: subcommand === 'available' ? 'Available Blockade Relief' : 'Your Blockade Relief Requests',
      collection,
      empty: subcommand === 'available' ? 'No current requests match your nation.' : 'You have no blockade relief requests.',
      commandName: 'unblockade',
      userId: interaction.user.id,
      sessions: context.sessions,
      variant: 'blockade',
      description: subcommand === 'available'
        ? 'Open relief requests your linked nation can currently claim.'
        : 'Blockade relief requests opened by your linked nation.',
      baseUrl: context.apiService.baseUrl,
      pageSize: 3,
    }));
  } catch (error) {
    await replyError(interaction, error);
  }
};

export const button = async (interaction, context) => {
  if (context.session.event === 'cancel') {
    await interaction.update(statusMessage({
      title: 'Blockade Relief Action Cancelled',
      tone: 'neutral',
      description: 'No blockade relief request was changed.',
    }));
    return;
  }

  await interaction.deferUpdate();
  try {
    const { action, body, id } = context.session.state;
    const actor = actorFromInteraction(interaction);
    let result;
    if (action === 'request') {
      result = await context.apiService.createBlockadeReliefRequest(actor, body);
    } else if (action === 'claim') {
      result = await context.apiService.claimBlockadeReliefRequest(actor, id);
    } else if (action === 'cancel') {
      result = await context.apiService.cancelBlockadeReliefRequest(actor, id);
    } else {
      throw Object.assign(new Error('This blockade relief control is no longer supported.'), {
        code: 'STALE_STATE',
      });
    }
    await interaction.editReply(mutationResultMessage(action, result));
  } catch (error) {
    await replyError(interaction, error);
  }
};
