import { SlashCommandBuilder } from 'discord.js';
import { actorFromInteraction, deferEphemeral, replyError } from '../utils/commandSupport.js';
import { allianceMessage, shareButton } from '../utils/directoryUi.js';

export const data = new SlashCommandBuilder()
  .setName('alliance')
  .setDescription('View a public-safe alliance summary from Nexus.')
  .addStringOption((option) => option
    .setName('alliance')
    .setDescription('Alliance name, acronym, or ID.')
    .setAutocomplete(true)
    .setRequired(true))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['directory']),
  examples: Object.freeze(['/alliance alliance:<alliance>']),
  related: Object.freeze(['nation']),
});

export const autocomplete = async (interaction, { apiService }) => {
  const query = `${interaction.options.getFocused() ?? ''}`.trim();
  if (!query) return interaction.respond([]);
  try {
    const result = await apiService.searchDirectoryAlliances(actorFromInteraction(interaction, 'alliance'), query);
    const items = Array.isArray(result?.items) ? result.items : [];
    await interaction.respond(items.slice(0, 25).map((item) => ({
      name: `${item?.name ?? 'Alliance'} · ${item?.description ?? `#${item?.id ?? ''}`}`.slice(0, 100),
      value: `${item?.id ?? ''}`,
    })).filter(({ value }) => /^\d{1,10}$/.test(value)));
  } catch {
    await interaction.respond([]).catch(() => {});
  }
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const allianceId = interaction.options.getString('alliance', true);
    if (!/^\d{1,10}$/.test(allianceId)) throw new TypeError('Choose a current alliance from autocomplete.');
    const alliance = await context.apiService.getDirectoryAlliance(
      actorFromInteraction(interaction, 'alliance'),
      allianceId,
    );
    const message = allianceMessage(alliance);
    if (alliance.shareable === true && context.sessions) {
      message.components = [shareButton(context.sessions, interaction, 'alliance', allianceId)];
    }
    await interaction.editReply(message);
  } catch (error) {
    await replyError(interaction, error, 'Alliance Lookup Failed');
  }
};

export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    const allianceId = `${context.session?.state?.entityId ?? ''}`;
    if (context.session?.event !== 'share' || !/^\d{1,10}$/.test(allianceId)) {
      throw new TypeError('This alliance share control is invalid or expired.');
    }
    const alliance = await context.apiService.getDirectoryAlliance(
      actorFromInteraction(interaction, 'alliance'),
      allianceId,
    );
    if (alliance.shareable !== true) throw new TypeError('Nexus did not authorize this public projection.');
    await interaction.followUp({ ...allianceMessage(alliance), ephemeral: false });
    await interaction.editReply({ components: [] });
  } catch (error) {
    await replyError(interaction, error, 'Alliance Share Failed');
  }
};
