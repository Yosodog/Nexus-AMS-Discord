import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError, summarizeItem,
} from '../utils/commandSupport.js';

export const data = new SlashCommandBuilder().setName('applications').setDescription('View and manage Nexus applications.')
  .addSubcommand((sub) => sub.setName('status').setDescription('View your application status.'))
  .addSubcommand((sub) => sub.setName('queue').setDescription('View the staff application queue.')
    .addStringOption((option) => option.setName('filter').setDescription('Queue filter').addChoices(
      { name: 'pending', value: 'pending' }, { name: 'stale', value: 'stale' },
    )))
  .addSubcommand((sub) => sub.setName('review').setDescription('Review an applicant or this application channel.')
    .addUserOption((option) => option.setName('applicant').setDescription('Applicant (defaults to current channel)')))
  .addSubcommand((sub) => sub.setName('approve').setDescription('Approve an application after confirmation.')
    .addStringOption((option) => option.setName('application').setDescription('Application').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sub) => sub.setName('deny').setDescription('Deny an application with a reason.')
    .addStringOption((option) => option.setName('application').setDescription('Application').setRequired(true).setAutocomplete(true)))
  .setDMPermission(false);

const applicationChoices = async (interaction, apiService) => {
  const result = await apiService.getStaffApplications(actorFromInteraction(interaction), {
    query: interaction.options.getFocused()?.trim?.() ?? '', limit: 25,
  });
  return normalizeCollection(result).items.slice(0, 25).map((application) => ({
    name: `${application.label ?? application.nation_name ?? application.applicant_name ?? 'Application'}`.slice(0, 100),
    value: `${application.token ?? application.id}`.slice(0, 100),
  }));
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, applicationChoices);

const approvalConfirmation = (interaction, context, application) => ({
  embeds: [new EmbedBuilder().setTitle('Confirm Application Approval').setColor(0xfee75c)
    .setDescription('Nexus will revalidate permissions and application state when you confirm.')],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
      event: 'approve-confirm', state: { application }, oneShot: true }))
      .setLabel('Approve application').setStyle(ButtonStyle.Success),
  )],
});

const denialModal = (interaction, context, application) => {
  const reasonId = context.sessions.create({ commandName: 'applications', userId: interaction.user.id, event: 'field', oneShot: true });
  const modalId = context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
    event: 'deny-reason', state: { application, reasonId }, oneShot: true });
  return new ModalBuilder().setCustomId(modalId).setTitle('Deny application')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(reasonId)
      .setLabel('Reason').setMaxLength(500).setRequired(true).setStyle(TextInputStyle.Paragraph)));
};

export const execute = async (interaction, context) => {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'deny') {
    await interaction.showModal(denialModal(
      interaction, context, interaction.options.getString('application', true),
    ));
    return;
  }
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  try {
    if (subcommand === 'status') {
      const result = await context.apiService.getMyApplications(actor);
      await interaction.editReply(collectionMessage({ title: 'Your Applications', collection: normalizeCollection(result),
        empty: 'No applications found.', commandName: 'applications', userId: interaction.user.id }));
      return;
    }
    if (subcommand === 'queue') {
      const result = await context.apiService.getStaffApplications(actor, {
        filter: interaction.options.getString('filter') ?? 'pending',
      });
      await interaction.editReply(collectionMessage({ title: 'Application Queue', collection: normalizeCollection(result),
        empty: 'No matching applications.', commandName: 'applications', userId: interaction.user.id }));
      return;
    }
    if (subcommand === 'review') {
      const applicant = interaction.options.getUser('applicant');
      const lookup = await context.apiService.getStaffApplications(actor, {
        applicant_discord_id: applicant?.id,
        discord_channel_id: applicant ? undefined : interaction.channelId,
        limit: 1,
      });
      const item = normalizeCollection(lookup).items[0];
      if (!item) throw Object.assign(new Error('No matching application was found.'), { code: 'NOT_FOUND' });
      const application = `${item.token ?? item.id}`;
      const result = await context.apiService.getStaffApplicationReview(actor, { application });
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('Application Review').setColor(0x5865f2)
          .setDescription(result?.summary ?? summarizeItem(result))],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
            event: 'approve-start', state: { application }, oneShot: true }))
            .setLabel('Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
            event: 'deny-start', state: { application }, oneShot: true }))
            .setLabel('Deny').setStyle(ButtonStyle.Danger),
        )],
      });
      return;
    }
    await interaction.editReply(approvalConfirmation(
      interaction, context, interaction.options.getString('application', true),
    ));
  } catch (error) { await replyError(interaction, error); }
};

export const modal = async (interaction, context) => {
  const { application, reasonId } = context.session.state;
  const reason = interaction.fields.getTextInputValue(reasonId).trim();
  if (!reason) {
    await interaction.reply({ content: 'A denial reason is required.', ephemeral: true });
    return;
  }
  const confirmId = context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
    event: 'deny-confirm', state: { application, reason }, oneShot: true });
  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle('Confirm Application Denial').setColor(0xfee75c)
      .setDescription('Nexus will record this reason and revalidate the application when you confirm.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel('Deny application').setStyle(ButtonStyle.Danger),
    )], ephemeral: true,
  });
};

export const button = async (interaction, context) => {
  if (context.session.event === 'deny-start') {
    await interaction.showModal(denialModal(interaction, context, context.session.state.application));
    return;
  }
  if (context.session.event === 'approve-start') {
    await interaction.update(approvalConfirmation(interaction, context, context.session.state.application));
    return;
  }
  await interaction.deferUpdate();
  const decision = context.session.event === 'approve-confirm' ? 'approve' : 'deny';
  try {
    const result = await context.apiService.decideStaffApplication(
      actorFromInteraction(interaction), context.session.state.application, decision,
      decision === 'deny' ? { reason: context.session.state.reason } : {},
    );
    await interaction.editReply({ content: result?.message ?? `Application ${decision}d.`, embeds: [], components: [] });
  } catch (error) { await replyError(interaction, error); }
};
