import { SlashCommandBuilder } from 'discord.js';
import { actorFromInteraction, deferEphemeral, replyError } from '../utils/commandSupport.js';
import { nationMessage, shareButton } from '../utils/directoryUi.js';

export const data = new SlashCommandBuilder()
  .setName('nation')
  .setDescription('View a public-safe nation summary from Nexus.')
  .addStringOption((option) => option
    .setName('nation')
    .setDescription('Nation name, leader, or ID.')
    .setAutocomplete(true)
    .setRequired(true))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['directory']),
  examples: Object.freeze(['/nation nation:<nation>']),
  related: Object.freeze(['who', 'alliance']),
});

export const autocomplete = async (interaction, { apiService }) => {
  const query = `${interaction.options.getFocused() ?? ''}`.trim();
  if (!query) return interaction.respond([]);
  try {
    const result = await apiService.searchDirectoryNations(actorFromInteraction(interaction, 'nation'), query);
    const items = Array.isArray(result?.items) ? result.items : [];
    await interaction.respond(items.slice(0, 25).map((item) => ({
      name: `${item?.name ?? 'Nation'} · ${item?.description ?? `#${item?.id ?? ''}`}`.slice(0, 100),
      value: `${item?.id ?? ''}`,
    })).filter(({ value }) => /^\d{1,10}$/.test(value)));
  } catch {
    await interaction.respond([]).catch(() => {});
  }
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const nationId = interaction.options.getString('nation', true);
    if (!/^\d{1,10}$/.test(nationId)) throw new TypeError('Choose a current nation from autocomplete.');
    const nation = await context.apiService.getDirectoryNation(
      actorFromInteraction(interaction, 'nation'),
      nationId,
    );
    const message = nationMessage(nation);
    if (nation.shareable === true && context.sessions) {
      message.components = [shareButton(context.sessions, interaction, 'nation', nationId)];
    }
    await interaction.editReply(message);
  } catch (error) {
    await replyError(interaction, error, 'Nation Lookup Failed');
  }
};

export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    const nationId = `${context.session?.state?.entityId ?? ''}`;
    if (context.session?.event !== 'share' || !/^\d{1,10}$/.test(nationId)) {
      throw new TypeError('This nation share control is invalid or expired.');
    }
    const nation = await context.apiService.getDirectoryNation(
      actorFromInteraction(interaction, 'nation'),
      nationId,
    );
    if (nation.shareable !== true) throw new TypeError('Nexus did not authorize this public projection.');
    await interaction.followUp({ ...nationMessage(nation), ephemeral: false });
    await interaction.editReply({ components: [] });
  } catch (error) {
    await replyError(interaction, error, 'Nation Share Failed');
  }
};
