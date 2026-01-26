import { EmbedBuilder } from 'discord.js';

/**
 * Dispatches queued Nexus Discord commands to the appropriate handler.
 * Designed for easy extension as new actions are added server-side.
 */
export class QueueDispatcher {
  constructor({ client, logger, guildId }) {
    this.client = client;
    this.logger = logger;
    this.guildId = guildId;

    this.handlers = {
      WAR_ALERT: (command) => this.#handleWarAlert(command),
      ALLIANCE_DEPARTURE: (command) => this.#handleAllianceDeparture(command),
      ALLIANCE_ROLE_REMOVAL: (command) => this.#handleAllianceRoleRemoval(command),
    };
  }

  /**
   * Dispatch a queued command to its action-specific handler.
   * @param {any} command queue item returned by Nexus
   * @returns {Promise<{ success: boolean, reason?: string }>}
   */
  async dispatch(command) {
    const action = command?.action;

    if (!action || typeof action !== 'string') {
      this.logger.warn('Queue item is missing an action', command?.id ?? 'unknown');
      return { success: false, reason: 'invalid_action' };
    }

    const handler = this.handlers[action];

    if (!handler) {
      this.logger.warn(`Unsupported queue action received: ${action}`);
      return { success: false, reason: 'unsupported_action' };
    }

    try {
      return await handler(command);
    } catch (error) {
      this.logger.error(`Unhandled error while processing ${action}`, error?.message ?? error);
      return { success: false, reason: 'handler_error' };
    }
  }

  async #handleAllianceDeparture(command) {
    const payload = command?.payload ?? {};
    const channelId = payload.channel_id;

    if (!channelId) {
      this.logger.warn('ALLIANCE_DEPARTURE payload missing channel_id', command?.id ?? 'unknown');
      return { success: false, reason: 'missing_channel' };
    }

    const channel = await this.#resolveChannel(channelId);

    if (!channel) {
      this.logger.warn('ALLIANCE_DEPARTURE channel missing or inaccessible', { channelId, commandId: command?.id });
      return { success: false, reason: 'channel_unavailable' };
    }

    const embed = this.#buildAllianceDepartureEmbed(command);

    try {
      await channel.send({ embeds: [embed] });
      this.logger.info('Delivered ALLIANCE_DEPARTURE embed', { commandId: command?.id, channelId });
      return { success: true };
    } catch (error) {
      this.logger.error('Failed to send ALLIANCE_DEPARTURE embed to Discord', error?.message ?? error);
      return { success: false, reason: 'discord_send_failed' };
    }
  }

  async #handleWarAlert(command) {
    const payload = command?.payload ?? {};
    const channelId = payload.channel_id;

    if (!channelId) {
      this.logger.warn('WAR_ALERT payload missing channel_id', command?.id ?? 'unknown');
      return { success: false, reason: 'missing_channel' };
    }

    const channel = await this.#resolveChannel(channelId);

    if (!channel) {
      this.logger.warn('WAR_ALERT channel missing or inaccessible', { channelId, commandId: command?.id });
      return { success: false, reason: 'channel_unavailable' };
    }

    const embed = this.#buildWarAlertEmbed(command);

    try {
      await channel.send({ embeds: [embed] });
      this.logger.info('Delivered WAR_ALERT embed', { commandId: command?.id, channelId });
      return { success: true };
    } catch (error) {
      this.logger.error('Failed to send WAR_ALERT embed to Discord', error?.message ?? error);
      return { success: false, reason: 'discord_send_failed' };
    }
  }

  async #handleAllianceRoleRemoval(command) {
    const payload = command?.payload ?? {};
    const discordId = payload.discord_id;

    if (!discordId) {
      this.logger.warn('ALLIANCE_ROLE_REMOVAL payload missing discord_id', command?.id ?? 'unknown');
      return { success: false, reason: 'missing_discord_id' };
    }

    const guild = await this.#resolveGuild();

    if (!guild) {
      this.logger.warn('ALLIANCE_ROLE_REMOVAL guild missing or inaccessible', {
        commandId: command?.id,
        guildId: this.guildId,
      });
      return { success: false, reason: 'guild_unavailable' };
    }

    let member;
    try {
      member = await guild.members.fetch(discordId);
    } catch (error) {
      this.logger.warn('ALLIANCE_ROLE_REMOVAL unable to fetch member', {
        commandId: command?.id,
        discordId,
        error: error?.message ?? error,
      });
      return { success: false, reason: 'member_unavailable' };
    }

    const rolesToRemove = member.roles.cache.filter((role) => role.id !== guild.id);
    const roleIds = rolesToRemove.map((role) => role.id);

    if (roleIds.length === 0) {
      this.logger.info('ALLIANCE_ROLE_REMOVAL member had no removable roles', {
        commandId: command?.id,
        discordId,
      });
      return { success: true };
    }

    try {
      await member.roles.remove(roleIds, 'Nexus AMS alliance role removal');
      this.logger.info('ALLIANCE_ROLE_REMOVAL removed roles from member', {
        commandId: command?.id,
        discordId,
        removedCount: roleIds.length,
        nationId: payload.nation_id ?? null,
        leftAt: payload.left_at ?? null,
      });
      return { success: true };
    } catch (error) {
      this.logger.error('ALLIANCE_ROLE_REMOVAL failed to remove roles', {
        commandId: command?.id,
        discordId,
        error: error?.message ?? error,
      });
      return { success: false, reason: 'role_removal_failed' };
    }
  }

  async #resolveChannel(channelId) {
    const cached = this.client.channels.cache.get(channelId);
    if (cached?.isTextBased?.()) {
      return cached;
    }

    try {
      const fetched = await this.client.channels.fetch(channelId);
      if (fetched?.isTextBased?.()) {
        return fetched;
      }

      return null;
    } catch (error) {
      this.logger.warn('Channel fetch failed or inaccessible', { channelId, error: error?.message ?? error });
      return null;
    }
  }

  async #resolveGuild() {
    if (!this.guildId) {
      this.logger.warn('Queue dispatcher missing guildId; cannot resolve guild.');
      return null;
    }

    const cached = this.client.guilds.cache.get(this.guildId);
    if (cached) {
      return cached;
    }

    try {
      const fetched = await this.client.guilds.fetch(this.guildId);
      return fetched ?? null;
    } catch (error) {
      this.logger.warn('Guild fetch failed or inaccessible', {
        guildId: this.guildId,
        error: error?.message ?? error,
      });
      return null;
    }
  }

  #buildWarAlertEmbed(command) {
    const payload = command?.payload ?? {};
    const createdAt = command?.created_at ? new Date(command.created_at) : new Date();

    const descriptionParts = [];
    if (payload.war_url) {
      descriptionParts.push(`➡️ [War Timeline](${payload.war_url})`);
    }
    if (payload.counter?.url) {
      const counterLabel = payload.counter.id ? `Counter #${payload.counter.id}` : 'Counter';
      descriptionParts.push(`🧭 [${counterLabel}](${payload.counter.url})`);
    }

    const embed = new EmbedBuilder().setTitle(`⚔️ War Alert${payload.war_id ? ` #${payload.war_id}` : ''}`);

    if (payload.war_url) {
      embed.setURL(payload.war_url);
    }

    embed
      .setColor(0xd64045)
      .setDescription(descriptionParts.join('\n') || 'A new war alert was received.')
      .addFields(
        { name: 'Attacker', value: this.#formatParticipant(payload.attacker, '🔥'), inline: true },
        { name: 'Defender', value: this.#formatParticipant(payload.defender, '🛡️'), inline: true },
        {
          name: 'Scores',
          value: `${this.#formatNumber(payload.attacker?.score)} vs ${this.#formatNumber(payload.defender?.score)}`,
          inline: true,
        },
        {
          name: 'Cities',
          value: `${this.#formatNumber(payload.attacker?.cities)} vs ${this.#formatNumber(payload.defender?.cities)}`,
          inline: true,
        },
        {
          name: 'Attacker Military',
          value: this.#formatMilitary(payload.attacker?.military),
        },
        {
          name: 'Defender Military',
          value: this.#formatMilitary(payload.defender?.military),
        },
      )
      .setTimestamp(createdAt);

    return embed;
  }

  #buildAllianceDepartureEmbed(command) {
    const payload = command?.payload ?? {};
    const nation = payload.nation ?? {};
    const leftAt = this.#parseDate(payload.left_at);
    const createdAt = this.#parseDate(command?.created_at) ?? new Date();
    const timestamp = leftAt ?? createdAt;

    const embed = new EmbedBuilder().setTitle('🏳️ Alliance Departure').setColor(0xf59f00);

    if (nation.links?.nation) {
      embed.setURL(nation.links.nation);
    }

    const descriptionLines = [
      `${nation.leader_name ?? 'A nation'} (${nation.nation_name ?? 'Unknown nation'}) has left ${
        this.#formatAlliance(payload.previous_alliance) ?? 'an alliance'
      }.`,
    ];

    if (payload.new_alliance) {
      descriptionLines.push(`New allegiance: ${this.#formatAlliance(payload.new_alliance)}.`);
    } else {
      descriptionLines.push('They are currently unaffiliated.');
    }

    if (nation.links?.nation) {
      descriptionLines.push(`🔗 [Nation Profile](${nation.links.nation})`);
    }

    embed
      .setDescription(descriptionLines.join('\n'))
      .addFields(
        {
          name: 'Previous Alliance',
          value: this.#formatAlliance(payload.previous_alliance) ?? 'Unknown',
          inline: true,
        },
        {
          name: 'New Alliance',
          value: this.#formatAlliance(payload.new_alliance) ?? 'Unaffiliated',
          inline: true,
        },
        {
          name: 'Timing',
          value: leftAt
            ? `${this.#formatDiscordTime(leftAt, 'f')} (${this.#formatDiscordTime(leftAt, 'R')})`
            : this.#formatDiscordTime(createdAt, 'R'),
        },
      )
      .setTimestamp(timestamp);

    return embed;
  }

  #formatParticipant(side = {}, emoji = '') {
    const leader = side.leader_name ?? 'Unknown leader';
    const nation = side.nation_name ?? 'Unknown nation';
    const allianceName = side.alliance?.name ?? null;
    const allianceLink = side.links?.alliance ?? side.alliance?.url ?? null;
    const alliance = allianceName && allianceLink ? `[${allianceName}](${allianceLink})` : allianceName ?? '—';

    const links = [];
    if (side.links?.nation) {
      links.push(`[Nation](${side.links.nation})`);
    }
    if (side.links?.alliance) {
      links.push(`[Alliance](${side.links.alliance})`);
    }

    const linkLine = links.length > 0 ? `🔗 ${links.join(' • ')}` : '🔗 No links provided';

    return `${emoji} **${nation}** (${leader})
Alliance: ${alliance}
${linkLine}`;
  }

  #formatMilitary(military = {}) {
    const unitOrder = [
      { key: 'soldiers', label: '🪖 Soldiers' },
      { key: 'tanks', label: '🛡️ Tanks' },
      { key: 'aircraft', label: '✈️ Aircraft' },
      { key: 'ships', label: '🚢 Ships' },
      { key: 'spies', label: '🕵️ Spies' },
      { key: 'missiles', label: '🎯 Missiles' },
      { key: 'nukes', label: '☢️ Nukes' },
    ];

    const parts = unitOrder.map(({ key, label }) => `${label}: ${this.#formatNumber(military[key])}`);
    return parts.join(' • ');
  }

  #formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return '—';
    }

    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value));
  }

  #formatAlliance(alliance) {
    if (!alliance || typeof alliance !== 'object') {
      return null;
    }

    const name = alliance.name ?? 'Unknown alliance';
    if (alliance.link) {
      return `[${name}](${alliance.link})`;
    }

    return name;
  }

  #formatDiscordTime(date, style = 'R') {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      return 'Unknown time';
    }

    const seconds = Math.floor(date.getTime() / 1000);
    return `<t:${seconds}:${style}>`;
  }

  #parseDate(input) {
    if (!input) {
      return null;
    }

    const date = input instanceof Date ? input : new Date(input);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
