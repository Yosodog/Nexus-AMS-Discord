import { SlashCommandBuilder } from 'discord.js';
import { approvalConfirmation } from './applications.js';
import { replyError } from '../utils/commandSupport.js';

/** Permanent compatibility alias for the canonical /applications approval flow. */
export const data = new SlashCommandBuilder()
  .setName('approve')
  .setDescription('Approve an applicant through the Nexus application workflow.')
  .addUserOption((option) => option
    .setName('user')
    .setDescription('Applicant to approve')
    .setRequired(true))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Application staff',
  topic: Object.freeze(['applications', 'staff']),
  examples: Object.freeze(['/approve user:<member>']),
  related: Object.freeze(['applications', 'apply', 'deny']),
});

export const execute = async (interaction, context) => {
  try {
    const applicant = interaction.options.getUser('user', true);
    await interaction.reply({
      ...approvalConfirmation(interaction, context, {
        applicantDiscordId: applicant.id,
        target: applicant.globalName ?? applicant.username ?? `Discord user ${applicant.id}`,
      }),
      ephemeral: true,
    });
  } catch (error) {
    await replyError(interaction, error, 'Approval Failed');
  }
};
