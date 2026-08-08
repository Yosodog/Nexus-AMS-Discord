import { SlashCommandBuilder } from 'discord.js';
import { denialModal } from './applications.js';
import { replyError } from '../utils/commandSupport.js';

/** Permanent compatibility alias for the canonical /applications denial flow. */
export const data = new SlashCommandBuilder()
  .setName('deny')
  .setDescription('Deny an applicant through the Nexus application workflow.')
  .addUserOption((option) => option
    .setName('user')
    .setDescription('Applicant to deny')
    .setRequired(true))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Application staff',
  topic: Object.freeze(['applications', 'staff']),
  examples: Object.freeze(['/deny user:<member>']),
  related: Object.freeze(['applications', 'apply', 'approve']),
});

export const execute = async (interaction, context) => {
  try {
    const applicant = interaction.options.getUser('user', true);
    await interaction.showModal(denialModal(interaction, context, {
      applicantDiscordId: applicant.id,
      target: applicant.globalName ?? applicant.username ?? `Discord user ${applicant.id}`,
    }));
  } catch (error) {
    await replyError(interaction, error, 'Denial Failed');
  }
};
