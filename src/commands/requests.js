import { SlashCommandBuilder } from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, normalizeCollection, replyError,
} from '../utils/commandSupport.js';

const SCOPES = ['mine', 'staff-queue'];
const TYPES = ['all', 'withdrawal', 'grant', 'city-grant', 'loan', 'war-aid', 'rebuilding', 'member-transfer', 'application'];
const STATUSES = ['open', 'closed', 'needs-attention'];
const choices = (option, values) => { values.forEach((value) => option.addChoices({ name: value, value })); return option; };

export const data = new SlashCommandBuilder()
  .setName('requests').setDescription('View your requests or the staff request queue.')
  .addStringOption((option) => choices(option.setName('scope').setDescription('Request scope').setRequired(true), SCOPES))
  .addStringOption((option) => choices(option.setName('type').setDescription('Request type'), TYPES))
  .addStringOption((option) => choices(option.setName('status').setDescription('Request status'), STATUSES))
  .setDMPermission(false);

const render = async (interaction, context, state = {}) => {
  const filters = {
    scope: state.scope ?? interaction.options?.getString?.('scope') ?? 'mine',
    type: state.type ?? interaction.options?.getString?.('type') ?? 'all',
    status: state.status ?? interaction.options?.getString?.('status') ?? 'open',
    page: state.page ?? 1,
  };
  const apiFilters = {
    ...filters,
    type: filters.type === 'all' ? undefined : filters.type.replaceAll('-', '_'),
  };
  const actor = actorFromInteraction(interaction);
  const result = filters.scope === 'staff-queue'
    ? await context.apiService.getStaffRequests(actor, apiFilters)
    : await context.apiService.getMyRequests(actor, apiFilters);
  return interaction.editReply(collectionMessage({
    title: filters.scope === 'staff-queue' ? 'Staff Request Queue' : 'Your Requests',
    collection: normalizeCollection(result), empty: 'No matching requests.', commandName: 'requests',
    userId: interaction.user.id, sessions: context.sessions, state: filters,
  }));
};
export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try { await render(interaction, context); } catch (error) { await replyError(interaction, error); }
};
export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try { await render(interaction, context, context.session.state); } catch (error) { await replyError(interaction, error); }
};
