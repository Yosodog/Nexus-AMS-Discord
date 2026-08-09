import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError, summarizeItem,
} from '../utils/commandSupport.js';
import {
  buildEmbed, buildPlainMessages, escapeMarkdown, formatDiscordTime, formatMilitary,
  formatNumber, markdownLink, statusLabel, statusMessage, titleCase, truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder().setName('war').setDescription('View active wars and war guidance.')
  .addSubcommand((sub) => sub.setName('active').setDescription('View your active wars.'))
  .addSubcommand((sub) => sub.setName('assignments').setDescription('View your current Milcom-v2 assignments.'))
  .addSubcommand((sub) => sub.setName('readiness').setDescription('View a Nexus Milcom-v2 readiness snapshot.')
    .addStringOption((option) => option.setName('nation').setDescription('Nation; defaults to your linked nation.')
      .setAutocomplete(true)))
  .addSubcommand((sub) => sub.setName('room').setDescription('View an actor-safe Milcom-v2 war-room summary.')
    .addIntegerOption((option) => option.setName('objective').setDescription('Milcom-v2 objective ID')
      .setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub.setName('counter').setDescription('Get counter guidance for a nation.')
    .addIntegerOption((option) => option.setName('nation').setDescription('Nation ID').setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub.setName('simulate').setDescription('View a war simulation summary.')
    .addStringOption((option) => option.setName('war').setDescription('War').setRequired(true).setAutocomplete(true)))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members and military staff',
  topic: Object.freeze(['member', 'military']),
  examples: Object.freeze([
    '/war active', '/war assignments', '/war readiness', '/war room objective:<objective-id>',
    '/war counter nation:<nation-id>', '/war simulate war:<war>',
  ]),
  related: Object.freeze(['raid', 'spy', 'waraid']),
});

const warSearchValues = (war) => [
  war?.label,
  war?.name,
  war?.summary,
  war?.token,
  war?.id,
].filter((value) => value !== undefined && value !== null).map((value) => `${value}`.toLowerCase());

const focusedValue = (interaction) => {
  const focused = interaction.options.getFocused?.(true);
  return `${focused && typeof focused === 'object' ? focused.value ?? '' : focused ?? ''}`.trim();
};

const warChoices = async (interaction, apiService) => {
  const query = focusedValue(interaction).toLowerCase();
  const result = await apiService.getMyActiveWars(actorFromInteraction(interaction));
  return normalizeCollection(result).items
    .filter((war) => !query || warSearchValues(war).some((value) => value.includes(query)))
    .slice(0, 25)
    .map((war) => ({
    name: `${war.label ?? war.name ?? war.summary ?? 'Active war'}`.slice(0, 100),
    value: `${war.token ?? war.id}`.slice(0, 100),
    }))
    .filter((choice) => choice.value && choice.value !== 'undefined');
};

const nationChoices = async (interaction, apiService) => {
  const query = focusedValue(interaction);
  if (!query) return [];
  const result = await apiService.searchDirectoryNations(actorFromInteraction(interaction, 'war'), query);
  return (Array.isArray(result?.items) ? result.items : []).slice(0, 25).map((nation) => ({
    name: `${nation?.name ?? 'Nation'} · ${nation?.description ?? `#${nation?.id ?? ''}`}`.slice(0, 100),
    value: `${nation?.id ?? ''}`,
  })).filter(({ value }) => /^\d{1,10}$/.test(value));
};

export const autocomplete = (interaction, { apiService }) => {
  const focused = interaction.options.getFocused?.(true);
  const optionName = focused && typeof focused === 'object'
    ? focused.name
    : interaction.options.getSubcommand?.() === 'readiness' ? 'nation' : 'war';
  return executeAutocomplete(interaction, apiService, optionName === 'nation' ? nationChoices : warChoices);
};

const safeText = (value, fallback = '—') => {
  if (value === undefined || value === null || `${value}`.trim() === '') return fallback;
  return escapeMarkdown(truncate(`${value}`, 500));
};

const allianceLabel = (alliance) => {
  if (!alliance?.name) return null;
  return safeText(alliance.acronym ? `${alliance.name} [${alliance.acronym}]` : alliance.name);
};

const channelReference = (channelId) => /^\d{17,20}$/.test(`${channelId ?? ''}`)
  ? `<#${channelId}>`
  : null;

const assignmentField = (assignment) => {
  const target = assignment?.target ?? {};
  const objective = assignment?.objective ?? {};
  const operation = assignment?.operation ?? {};
  const war = assignment?.war;
  const links = assignment?.links ?? {};
  const response = assignment?.response;
  const room = assignment?.room?.available ? channelReference(assignment.room.discord_channel_id) : null;
  const lines = [
    `**Operation:** ${safeText(operation.name)} · Wave ${formatNumber(operation.wave, { maximumFractionDigits: 0 })}`,
    `**Assignment:** ${safeText(statusLabel(assignment?.status) ?? titleCase(assignment?.status))} · Rank ${formatNumber(assignment?.rank, { maximumFractionDigits: 0 })}`,
    `**Objective:** ${safeText(statusLabel(objective.status) ?? titleCase(objective.status))} · ${safeText(titleCase(objective.war_type))}`,
    allianceLabel(target.alliance) ? `**Alliance:** ${allianceLabel(target.alliance)}` : null,
    objective.deadline_at ? `**Deadline:** ${formatDiscordTime(objective.deadline_at)}` : null,
    response?.response
      ? `**Response:** ${safeText(statusLabel(response.response) ?? titleCase(response.response))}${response.reason ? ` · ${safeText(response.reason)}` : ''}`
      : '**Response:** Awaiting your response',
    war ? `**War:** ${formatNumber(war.turns_left, { maximumFractionDigits: 0 })} turns · ${formatNumber(war.friendly_resistance, { maximumFractionDigits: 0 })}/${formatNumber(war.target_resistance, { maximumFractionDigits: 0 })} resistance` : null,
    room ? `**Room:** ${room}` : '**Room:** Not attached',
    [
      links.target_nation ? markdownLink('Target', links.target_nation) : null,
      war?.id && links.war_timeline ? markdownLink('Timeline', links.war_timeline) : null,
      !war?.id && links.declare_war ? markdownLink('Declare war', links.declare_war) : null,
    ].filter(Boolean).join(' · '),
  ].filter(Boolean);
  return {
    name: truncate(`${safeText(objective.priority, 'P?').toUpperCase()} · ${safeText(target.nation_name, `Nation #${target.id ?? '?'}`)}`, 256),
    value: lines.join('\n'),
  };
};

const assignmentId = (assignment) => {
  const value = Number(assignment?.assignment_id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const assignmentControls = (assignments, interaction, context) => assignments.slice(0, 5)
  .map((assignment) => {
    const id = assignmentId(assignment);
    if (id === null) return null;
    const currentResponse = assignment?.response?.response;
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(context.sessions.create({
          commandName: 'war', userId: interaction.user.id,
          event: 'assignment-acknowledge-start', state: { assignmentId: id }, oneShot: true,
        }))
        .setLabel(`Acknowledge #${id}`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(currentResponse === 'acknowledged'),
      new ButtonBuilder()
        .setCustomId(context.sessions.create({
          commandName: 'war', userId: interaction.user.id,
          event: 'assignment-unavailable-start', state: { assignmentId: id }, oneShot: true,
        }))
        .setLabel(`Unavailable #${id}`)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(currentResponse === 'unavailable'),
    );
  })
  .filter(Boolean);

const assignmentsMessage = (result, interaction, context) => {
  const assignments = normalizeCollection(result).items;
  return {
    embeds: [buildEmbed({
      title: 'Milcom-v2 Assignments',
      tone: 'military',
      description: assignments.length
        ? 'Current assignments Nexus has approved for your linked nation.'
        : 'Nexus has no current Milcom-v2 assignments for your linked nation.',
      fields: assignments.slice(0, 10).map(assignmentField),
      footer: assignments.length > 10
        ? `Showing 10 of ${assignments.length} assignments. Open Nexus for the complete list.`
        : `${assignments.length} current assignment${assignments.length === 1 ? '' : 's'}${assignments.length > 5 ? ' · Response controls shown for the first 5' : ''}`,
      timestamp: true,
    })],
    components: assignmentControls(assignments, interaction, context),
    allowedMentions: { parse: [] },
  };
};

const invalidAssignmentControl = () => Object.assign(
  new Error('This assignment control is no longer valid. Run /war assignments to refresh it.'),
  { code: 'VALIDATION_ERROR' },
);

const unavailableModal = (interaction, context, id) => {
  const reasonId = context.sessions.create({
    commandName: 'war', userId: interaction.user.id, event: 'field', oneShot: true,
  });
  const modalId = context.sessions.create({
    commandName: 'war', userId: interaction.user.id,
    event: 'assignment-unavailable-reason', state: { assignmentId: id, reasonId }, oneShot: true,
  });
  return new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('Assignment unavailable')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(reasonId)
        .setLabel('Why are you unavailable?')
        .setRequired(true)
        .setMaxLength(500)
        .setStyle(TextInputStyle.Paragraph),
    ));
};

const assignmentResponseConfirmation = (interaction, context, preview) => {
  const id = assignmentId(preview?.assignment);
  const intentId = `${preview?.intent?.id ?? ''}`;
  const proposed = preview?.proposed_response ?? {};
  if (id === null || !intentId) throw invalidAssignmentControl();
  const target = preview.assignment?.target ?? {};
  const confirmId = context.sessions.create({
    commandName: 'war', userId: interaction.user.id,
    event: 'assignment-response-confirm', state: { assignmentId: id, intentId }, oneShot: true,
  });
  const cancelId = context.sessions.create({
    commandName: 'war', userId: interaction.user.id,
    event: 'assignment-response-cancel', state: { assignmentId: id }, oneShot: true,
  });
  return statusMessage({
    title: proposed.response === 'unavailable'
      ? 'Confirm Assignment Unavailable'
      : 'Confirm Assignment Acknowledgement',
    tone: 'warning',
    description: 'Nexus will revalidate the assignment, your linked nation, and this installation when you confirm.',
    fields: [
      { name: 'Assignment', value: `#${id}`, inline: true },
      { name: 'Target', value: safeText(target.nation_name, `Nation #${target.id ?? '?'}`), inline: true },
      { name: 'Response', value: safeText(statusLabel(proposed.response) ?? titleCase(proposed.response)), inline: true },
      proposed.reason ? { name: 'Reason', value: safeText(proposed.reason) } : null,
      preview.intent?.expires_at
        ? { name: 'Confirmation expires', value: formatDiscordTime(preview.intent.expires_at), inline: true }
        : null,
    ],
    footer: 'The response is recorded and audited in Nexus. It does not change the assignment state by itself.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm response').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });
};

const readinessMessage = (readiness) => {
  const nation = readiness?.nation ?? {};
  const slots = readiness?.offensive_slots ?? {};
  const freshness = readiness?.freshness ?? {};
  return {
    embeds: [buildEmbed({
      title: `Readiness · ${safeText(nation.nation_name, `Nation #${nation.id ?? '?'}`)}`,
      tone: 'military',
      description: 'Persisted Milcom-v2 snapshot from Nexus. Values are shown as recorded; Discord does not recalculate readiness.',
      fields: [
        {
          name: 'Nation',
          value: [
            `**Leader:** ${safeText(nation.leader_name)}`,
            allianceLabel(nation.alliance) ? `**Alliance:** ${allianceLabel(nation.alliance)}` : null,
            `**Score:** ${formatNumber(readiness?.score)} · **Cities:** ${formatNumber(readiness?.cities, { maximumFractionDigits: 0 })}`,
            `**Vacation turns:** ${formatNumber(readiness?.vacation_turns, { maximumFractionDigits: 0 })} · **Beige turns:** ${formatNumber(readiness?.beige_turns, { maximumFractionDigits: 0 })}`,
          ].filter(Boolean).join('\n'),
        },
        {
          name: 'Offensive slots at snapshot',
          value: [
            `**Capacity:** ${formatNumber(slots.capacity_at_snapshot, { maximumFractionDigits: 0 })}`,
            `**Active wars:** ${formatNumber(slots.active_wars_at_snapshot, { maximumFractionDigits: 0 })}`,
            `**Reserved:** ${formatNumber(slots.reserved_at_snapshot, { maximumFractionDigits: 0 })}`,
          ].join(' · '),
        },
        { name: 'Military at snapshot', value: formatMilitary(readiness?.military, { multiline: true }) ?? 'No military values were provided.' },
        {
          name: 'Source freshness',
          value: [
            `**Fetched:** ${formatDiscordTime(freshness.fetched_at)}`,
            freshness.last_active_at ? `**Last active:** ${formatDiscordTime(freshness.last_active_at)}` : null,
            `**Completeness:** ${formatNumber(freshness.completeness_percent, { maximumFractionDigits: 0 })}%`,
          ].filter(Boolean).join(' · '),
        },
      ],
      footer: nation.id ? `Nation ID ${nation.id}` : null,
      timestamp: true,
    })],
    components: [],
  };
};

const warRoomMessage = (room) => {
  const target = room?.target ?? {};
  const operation = room?.operation ?? {};
  const assigned = Array.isArray(room?.assigned_members) ? room.assigned_members : [];
  const members = assigned.slice(0, 10).map((assignment) => {
    const nation = assignment?.nation ?? {};
    const war = assignment?.war;
    return [
      `**${safeText(nation.nation_name, `Nation #${nation.id ?? '?'}`)}:** ${safeText(statusLabel(assignment?.status) ?? titleCase(assignment?.status))}`,
      war ? `${formatNumber(war.turns_left, { maximumFractionDigits: 0 })} turns · ${formatNumber(war.friendly_resistance, { maximumFractionDigits: 0 })}/${formatNumber(war.target_resistance, { maximumFractionDigits: 0 })} resistance` : null,
    ].filter(Boolean).join(' · ');
  });
  const channel = channelReference(room?.discord_channel_id);
  return {
    embeds: [buildEmbed({
      title: `War Room · ${safeText(target.nation_name, `Nation #${target.id ?? '?'}`)}`,
      tone: 'military',
      description: room?.reason ? safeText(room.reason) : 'Actor-safe Milcom-v2 room summary from Nexus.',
      fields: [
        {
          name: 'Objective',
          value: [
            `**Status:** ${safeText(statusLabel(room?.status) ?? titleCase(room?.status))}`,
            `**Priority:** ${safeText(room?.priority).toUpperCase()} · **War type:** ${safeText(titleCase(room?.war_type))}`,
            room?.deadline_at ? `**Deadline:** ${formatDiscordTime(room.deadline_at)}` : null,
            channel ? `**Channel:** ${channel}` : null,
          ].filter(Boolean).join('\n'),
        },
        {
          name: 'Operation',
          value: `${safeText(operation.name)} · ${safeText(titleCase(operation.type))} · Wave ${formatNumber(operation.wave, { maximumFractionDigits: 0 })}`,
        },
        {
          name: 'Target',
          value: [
            `**Leader:** ${safeText(target.leader_name)} · **Score:** ${formatNumber(target.score)} · **Cities:** ${formatNumber(target.cities, { maximumFractionDigits: 0 })}`,
            allianceLabel(target.alliance) ? `**Alliance:** ${allianceLabel(target.alliance)}` : null,
            room?.links?.target_nation ? markdownLink('Open target nation', room.links.target_nation) : null,
          ].filter(Boolean).join('\n'),
        },
        members.length ? { name: 'Assigned members', value: members.join('\n') } : null,
      ],
      footer: [
        room?.objective_id ? `Objective ${room.objective_id}` : null,
        assigned.length > 10 ? `Showing 10 of ${assigned.length} members` : `${assigned.length} assigned member${assigned.length === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · '),
      timestamp: true,
    })],
    components: [],
    allowedMentions: { parse: [] },
  };
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === 'assignments') {
      const result = await context.apiService.getMilcomAssignments(actor);
      await interaction.editReply(assignmentsMessage(result, interaction, context));
      return;
    }
    if (subcommand === 'readiness') {
      const nationId = interaction.options.getString('nation');
      if (nationId !== null && !/^\d{1,10}$/.test(nationId)) {
        throw new TypeError('Choose a current nation from autocomplete.');
      }
      const result = await context.apiService.getMilcomReadiness(actor, nationId ? { nation_id: nationId } : {});
      await interaction.editReply(readinessMessage(result));
      return;
    }
    if (subcommand === 'room') {
      const result = await context.apiService.getMilcomWarRoom(
        actor,
        interaction.options.getInteger('objective', true),
      );
      await interaction.editReply(warRoomMessage(result));
      return;
    }
    if (subcommand === 'counter') {
      const result = await context.apiService.getWarCounterRecommendation(actor, interaction.options.getInteger('nation', true));
      await interaction.editReply(collectionMessage({
        title: 'Counter Guidance',
        collection: normalizeCollection(result),
        empty: 'No counter guidance is available.',
        commandName: 'war',
        userId: interaction.user.id,
        sessions: context.sessions,
        variant: 'war-counter',
        description: `Recommended counters for nation #${interaction.options.getInteger('nation', true)}.`,
        baseUrl: context.apiService.baseUrl,
        pageSize: 3,
      }));
      return;
    }
    if (subcommand === 'simulate') {
      const result = await context.apiService.getWarSimulation(actor, interaction.options.getString('war', true));
      const summary = typeof result?.summary === 'string'
        ? escapeMarkdown(truncate(result.summary, 6_000))
        : summarizeItem(result);
      const messages = buildPlainMessages({
        title: 'War Simulation',
        tone: 'military',
        description: summary,
        footer: 'Simulation results are estimates. Verify the live war state before acting.',
      });
      await interaction.editReply(messages[0]);
      for (const message of messages.slice(1)) {
        await interaction.followUp({ ...message, ephemeral: true });
      }
      return;
    }
    const result = await context.apiService.getMyActiveWars(actor);
    await interaction.editReply(collectionMessage({
      title: 'Active Wars',
      collection: normalizeCollection(result),
      empty: 'No active wars.',
      commandName: 'war',
      userId: interaction.user.id,
      sessions: context.sessions,
      variant: 'war',
      description: 'Wars currently active for your linked nation.',
      baseUrl: context.apiService.baseUrl,
      pageSize: 3,
    }));
  } catch (error) { await replyError(interaction, error); }
};

export const modal = async (interaction, context) => {
  if (context.session.event !== 'assignment-unavailable-reason') {
    await replyError(interaction, invalidAssignmentControl());
    return;
  }
  const id = Number(context.session.state.assignmentId);
  const reason = interaction.fields.getTextInputValue(context.session.state.reasonId).trim();
  if (!Number.isSafeInteger(id) || id < 1 || !reason) {
    await replyError(interaction, invalidAssignmentControl());
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const preview = await context.apiService.previewMilcomAssignmentResponse(
      actorFromInteraction(interaction, 'war'),
      id,
      { response: 'unavailable', reason },
    );
    await interaction.editReply(assignmentResponseConfirmation(interaction, context, preview));
  } catch (error) { await replyError(interaction, error); }
};

export const button = async (interaction, context) => {
  const event = context.session.event;
  const id = Number(context.session.state.assignmentId);
  if (!Number.isSafeInteger(id) || id < 1) {
    await replyError(interaction, invalidAssignmentControl());
    return;
  }
  if (event === 'assignment-unavailable-start') {
    await interaction.showModal(unavailableModal(interaction, context, id));
    return;
  }
  if (event === 'assignment-response-cancel') {
    await interaction.update(statusMessage({
      title: 'Assignment Response Cancelled',
      tone: 'neutral',
      description: 'No Milcom-v2 assignment response was changed.',
    }));
    return;
  }
  if (event === 'assignment-acknowledge-start') {
    await interaction.deferUpdate();
    try {
      const preview = await context.apiService.previewMilcomAssignmentResponse(
        actorFromInteraction(interaction, 'war'),
        id,
        { response: 'acknowledged' },
      );
      await interaction.editReply(assignmentResponseConfirmation(interaction, context, preview));
    } catch (error) { await replyError(interaction, error); }
    return;
  }
  if (event !== 'assignment-response-confirm' || !context.session.state.intentId) {
    await replyError(interaction, invalidAssignmentControl());
    return;
  }
  await interaction.deferUpdate();
  try {
    const result = await context.apiService.confirmMilcomAssignmentResponse(
      actorFromInteraction(interaction, 'war'),
      id,
      context.session.state.intentId,
    );
    const unavailable = result?.response === 'unavailable';
    await interaction.editReply(statusMessage({
      title: unavailable ? 'Assignment Marked Unavailable' : 'Assignment Acknowledged',
      tone: unavailable ? 'warning' : 'success',
      description: unavailable
        ? 'Nexus recorded that you are unavailable for this assignment.'
        : 'Nexus recorded your assignment acknowledgement.',
      fields: [
        { name: 'Assignment', value: `#${id}`, inline: true },
        { name: 'Response', value: safeText(statusLabel(result?.response) ?? titleCase(result?.response)), inline: true },
        result?.reason ? { name: 'Reason', value: safeText(result.reason) } : null,
      ],
      footer: 'Run /war assignments to refresh your current assignment view.',
    }));
  } catch (error) { await replyError(interaction, error); }
};
