import { SlashCommandBuilder } from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, normalizeCollection, replyError,
} from '../utils/commandSupport.js';

export const data = new SlashCommandBuilder()
  .setName('audit')
  .setDescription('Review and manage your active Nexus audit findings.')
  .addSubcommand((subcommand) => subcommand.setName('status').setDescription('View your active audit findings.'))
  .addSubcommand((subcommand) => subcommand.setName('acknowledge').setDescription('Acknowledge an audit finding.')
    .addIntegerOption((option) => option.setName('finding').setDescription('Audit finding ID').setRequired(true).setMinValue(1))
    .addStringOption((option) => option.setName('note').setDescription('Optional remediation note').setMaxLength(500)))
  .addSubcommand((subcommand) => subcommand.setName('snooze').setDescription('Snooze Discord reminders for a finding.')
    .addIntegerOption((option) => option.setName('finding').setDescription('Audit finding ID').setRequired(true).setMinValue(1))
    .addIntegerOption((option) => option.setName('hours').setDescription('Snooze duration in hours').setRequired(true)
      .addChoices(
        { name: '1 day', value: 24 },
        { name: '3 days', value: 72 },
        { name: '7 days', value: 168 },
      )))
  .setDMPermission(false);

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'acknowledge') {
      const result = await context.apiService.acknowledgeAuditFinding(
        actor,
        interaction.options.getInteger('finding', true),
        { note: interaction.options.getString('note') ?? undefined },
      );
      await interaction.editReply({ content: result?.message ?? 'Audit finding acknowledged.' });
      return;
    }

    if (subcommand === 'snooze') {
      const result = await context.apiService.snoozeAuditFinding(
        actor,
        interaction.options.getInteger('finding', true),
        { hours: interaction.options.getInteger('hours', true) },
      );
      await interaction.editReply({ content: result?.message ?? 'Audit reminders snoozed.' });
      return;
    }

    const result = await context.apiService.getMyAuditFindings(actor);
    await interaction.editReply(collectionMessage({
      title: 'Your Audit Findings',
      collection: normalizeCollection(result),
      empty: 'No active audit findings.',
      commandName: 'audit',
      userId: interaction.user.id,
    }));
  } catch (error) {
    await replyError(interaction, error);
  }
};
