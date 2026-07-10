import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';
import { invalid, valid } from './support.js';

export const validate = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid('invalid_payload');
  if (!payload.discord_id) return invalid('missing_discord_id');
  if (!isDiscordSnowflake(payload.discord_id)) return invalid('invalid_discord_id');
  return valid();
};

export const execute = async (command, runtime) => {
  const payload = command.payload;
  const discordId = payload.discord_id.trim();
  const guild = await runtime.resolveGuild();
  if (!guild) {
    runtime.logger.warn('ALLIANCE_ROLE_REMOVAL guild missing or inaccessible', {
      commandId: command?.id,
      guildId: runtime.guildId,
    });
    return { success: false, reason: 'guild_unavailable' };
  }

  let member;
  try {
    member = await guild.members.fetch(discordId);
  } catch (error) {
    runtime.logger.warn('ALLIANCE_ROLE_REMOVAL unable to fetch member', {
      commandId: command?.id,
      discordId,
      error: error?.message ?? error,
    });
    return { success: false, reason: 'member_unavailable' };
  }

  const assignedRoles = Array.from(member.roles.cache.values?.() ?? [])
    .filter((role) => role.id !== guild.id);
  const removableRoles = assignedRoles.filter((role) => role.editable !== false && !role.managed);
  const uneditableRoles = assignedRoles.filter((role) => role.editable === false || role.managed);
  const roleIds = removableRoles.map((role) => role.id);

  if (uneditableRoles.length > 0) {
    runtime.logger.warn('ALLIANCE_ROLE_REMOVAL cannot remove managed or uneditable roles', {
      commandId: command?.id,
      discordId,
      roleIds: uneditableRoles.map((role) => role.id),
    });
  }

  if (roleIds.length === 0) {
    runtime.logger.info('ALLIANCE_ROLE_REMOVAL member had no removable roles', {
      commandId: command?.id,
      discordId,
    });
    return { success: true };
  }

  if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };

  try {
    await runtime.withDiscordRetry(
      () => member.roles.remove(roleIds, 'Nexus AMS alliance role removal'),
      'remove ALLIANCE_ROLE_REMOVAL roles',
    );
    if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };

    const refreshed = await guild.members.fetch(discordId);
    const remainingEditable = Array.from(refreshed.roles.cache.values?.() ?? [])
      .filter((role) => role.id !== guild.id && role.editable !== false && !role.managed)
      .map((role) => role.id);
    if (remainingEditable.length > 0) {
      runtime.logger.error('ALLIANCE_ROLE_REMOVAL left editable roles assigned', {
        commandId: command?.id,
        discordId,
        roleIds: remainingEditable,
      });
      return { success: false, reason: 'roles_remain' };
    }

    runtime.logger.info('ALLIANCE_ROLE_REMOVAL removed roles from member', {
      commandId: command?.id,
      discordId,
      removedCount: roleIds.length,
      nationId: payload.nation_id ?? null,
      leftAt: payload.left_at ?? null,
    });
    return { success: true };
  } catch (error) {
    runtime.logger.error('ALLIANCE_ROLE_REMOVAL failed to remove roles', {
      commandId: command?.id,
      discordId,
      error: error?.message ?? error,
    });
    return { success: false, reason: 'role_removal_failed' };
  }
};
