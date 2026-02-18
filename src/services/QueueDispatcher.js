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
      INACTIVITY_ALERT: (command) => this.#handleInactivityAlert(command),
      ALLIANCE_ROLE_REMOVAL: (command) => this.#handleAllianceRoleRemoval(command),
      BEIGE_ALERT: (command) => this.#handleBeigeAlert(command),
      WAR_ROOM_CREATE: (command) => this.#handleWarRoomCreate(command),
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

  async #handleInactivityAlert(command) {
    const payload = command?.payload ?? {};
    const channelId = payload.channel_id;

    if (!channelId) {
      this.logger.warn('INACTIVITY_ALERT payload missing channel_id', command?.id ?? 'unknown');
      return { success: false, reason: 'missing_channel' };
    }

    const channel = await this.#resolveChannel(channelId);

    if (!channel) {
      this.logger.warn('INACTIVITY_ALERT channel missing or inaccessible', { channelId, commandId: command?.id });
      return { success: false, reason: 'channel_unavailable' };
    }

    const embed = this.#buildInactivityAlertEmbed(command);
    const mention = this.#buildInactivityAlertMention(payload);

    try {
      await channel.send({
        content: mention ?? undefined,
        embeds: [embed],
      });
      this.logger.info('Delivered INACTIVITY_ALERT message', { commandId: command?.id, channelId });
      return { success: true };
    } catch (error) {
      this.logger.error('Failed to send INACTIVITY_ALERT message to Discord', error?.message ?? error);
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

  async #handleBeigeAlert(command) {
    const payload = command?.payload ?? {};
    const channelId = payload.channel_id;

    if (!channelId) {
      this.logger.warn('BEIGE_ALERT payload missing channel_id', command?.id ?? 'unknown');
      return { success: false, reason: 'missing_channel' };
    }

    const channel = await this.#resolveChannel(channelId);

    if (!channel) {
      this.logger.warn('BEIGE_ALERT channel missing or inaccessible', { channelId, commandId: command?.id });
      return { success: false, reason: 'channel_unavailable' };
    }

    try {
      if (Array.isArray(payload.nations) && payload.nations.length > 0) {
        const messages = this.#buildBeigeTurnMessages(command);

        for (const content of messages) {
          await channel.send({ content });
        }

        this.logger.info('Delivered BEIGE_ALERT turn-summary messages', {
          commandId: command?.id,
          channelId,
          messagesSent: messages.length,
          nationCount: payload.nations.length,
        });

        return { success: true };
      }

      if (payload.nation && typeof payload.nation === 'object') {
        const embed = this.#buildBeigeExitEmbed(command);
        await channel.send({ embeds: [embed] });

        this.logger.info('Delivered BEIGE_ALERT single-exit embed', {
          commandId: command?.id,
          channelId,
          eventType: payload.event_type ?? null,
        });

        return { success: true };
      }

      this.logger.warn('BEIGE_ALERT payload missing nation/nations data', command?.id ?? 'unknown');
      return { success: false, reason: 'invalid_payload' };
    } catch (error) {
      this.logger.error('Failed to send BEIGE_ALERT message to Discord', error?.message ?? error);
      return { success: false, reason: 'discord_send_failed' };
    }
  }

  async #handleWarRoomCreate(command) {
    const payload = command?.payload ?? {};
    const forumChannelId = payload.forum_channel_id ?? payload.channel_id;

    if (!forumChannelId) {
      this.logger.warn('WAR_ROOM_CREATE payload missing forum_channel_id', command?.id ?? 'unknown');
      return { success: false, reason: 'missing_channel' };
    }

    const forum = await this.#resolveAnyChannel(forumChannelId);

    if (!forum || !forum.isThreadOnly?.()) {
      this.logger.warn('WAR_ROOM_CREATE forum channel missing/inaccessible or not a forum', {
        channelId: forumChannelId,
        commandId: command?.id,
      });
      return { success: false, reason: 'channel_unavailable' };
    }

    const roomName = this.#buildWarRoomName(payload);
    const mentions = this.#buildWarRoomMentions(payload.assigned_members);
    const mentionMessages = this.#buildWarRoomMentionMessages(mentions);
    const embed = this.#buildWarRoomEmbed(command);
    const assignmentMessages = this.#buildWarRoomAssignmentMessages(payload.assigned_members);

    try {
      const starterContentParts = ['## War Room Opened', 'Target briefing below. Assignments and pings follow.'];

      const thread = await this.#withDiscordRetry(
        () =>
          forum.threads.create({
            name: roomName,
            message: {
              content: starterContentParts.join('\n'),
              embeds: [embed],
            },
          }),
        `create WAR_ROOM_CREATE forum thread ${roomName}`,
      );

      for (const content of mentionMessages) {
        await this.#withDiscordRetry(
          () =>
            thread.send({
              content,
              allowedMentions: { parse: ['users'] },
            }),
          'send WAR_ROOM_CREATE mention message',
        );
      }

      for (const content of assignmentMessages) {
        await this.#withDiscordRetry(() => thread.send({ content }), 'send WAR_ROOM_CREATE assignment message');
      }

      this.logger.info('Delivered WAR_ROOM_CREATE thread', {
        commandId: command?.id,
        forumChannelId,
        threadId: thread.id,
        targetNationId: payload?.target?.id ?? null,
        assignedCount: Array.isArray(payload.assigned_members) ? payload.assigned_members.length : 0,
      });

      return { success: true };
    } catch (error) {
      this.logger.error('Failed to create/send WAR_ROOM_CREATE thread in Discord', error?.message ?? error);
      return { success: false, reason: 'discord_send_failed' };
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

  async #resolveAnyChannel(channelId) {
    const cached = this.client.channels.cache.get(channelId);
    if (cached) {
      return cached;
    }

    try {
      const fetched = await this.client.channels.fetch(channelId);
      return fetched ?? null;
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

  #buildInactivityAlertEmbed(command) {
    const payload = command?.payload ?? {};
    const leader = payload.leader_name ?? 'Unknown leader';
    const nationName = payload.nation_name ?? 'Unknown nation';
    const nationId = payload.nation_id ? `, #${payload.nation_id}` : '';
    const lastActiveAt = this.#parseDate(payload.last_active_at);
    const createdAt = this.#parseDate(command?.created_at) ?? new Date();
    const threshold = payload.threshold_hours ?? this.#extractThresholdFromMessage(payload.message);

    const embed = new EmbedBuilder()
      .setTitle('⏰ Inactivity Alert')
      .setColor(0xe67700)
      .setDescription(`**${leader}** (${nationName}${nationId}) has exceeded inactivity limits.`)
      .addFields({
        name: 'Last Active',
        value: lastActiveAt
          ? `${this.#formatDiscordTime(lastActiveAt, 'f')} (${this.#formatDiscordTime(lastActiveAt, 'R')})`
          : 'Unknown',
      })
      .setTimestamp(lastActiveAt ?? createdAt);

    if (threshold) {
      embed.addFields({ name: 'Threshold', value: `${threshold}h`, inline: true });
    }

    return embed;
  }

  #buildInactivityAlertMention(payload = {}) {
    if (!payload.discord_user_id) {
      return null;
    }

    return `<@${payload.discord_user_id}>`;
  }

  #extractThresholdFromMessage(message) {
    if (typeof message !== 'string') {
      return null;
    }

    const match = message.match(/threshold:\s*(\d+)h/i);
    return match?.[1] ?? null;
  }

  #parseDate(input) {
    if (!input) {
      return null;
    }

    const date = input instanceof Date ? input : new Date(input);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  #buildBeigeTurnMessages(command) {
    const payload = command?.payload ?? {};
    const nations = Array.isArray(payload.nations) ? payload.nations : [];
    const turnTime = this.#parseDate(payload.turn_change_at);
    const createdAt = this.#parseDate(command?.created_at);

    const eventLabel = this.#describeBeigeEvent(payload.event_type, payload.window);
    const count = payload.nation_count ?? nations.length;
    const headerParts = [`🟨 **Beige Watch**`, eventLabel, `Nations: **${this.#formatNumber(count)}**`];

    if (turnTime) {
      headerParts.push(
        `Turn: ${this.#formatDiscordTime(turnTime, 'f')} (${this.#formatDiscordTime(turnTime, 'R')})`,
      );
    } else if (createdAt) {
      headerParts.push(`Updated: ${this.#formatDiscordTime(createdAt, 'R')}`);
    }

    const lines = nations.map((nation, index) => {
      const nationName = nation?.nation_name ?? 'Unknown nation';
      const leader = nation?.leader_name ?? 'Unknown leader';
      const nationLink = nation?.links?.nation ?? null;
      const allianceName = nation?.alliance?.name ?? 'No alliance';
      const allianceLink = nation?.links?.alliance ?? null;
      const score = this.#formatNumber(nation?.score);
      const cities = this.#formatNumber(nation?.cities);
      const beigeTurns = this.#formatNumber(nation?.beige_turns);
      const military = nation?.military ?? {};
      const declareWarUrl = this.#buildDeclareWarUrl(nation?.id);

      const nationLabel = nationLink ? `[${nationName}](${nationLink})` : nationName;
      const allianceLabel = allianceLink ? `[${allianceName}](${allianceLink})` : allianceName;
      const declareWarLabel = declareWarUrl ? `[Declare War](${declareWarUrl})` : 'Declare War: —';

      return `${index + 1}. ${nationLabel} (${leader}) | ${allianceLabel} | ${declareWarLabel} | Score: ${score} | Cities: ${cities} | Beige: ${beigeTurns} | Mil: 🪖 ${this.#formatNumber(military.soldiers)} • 🛡️ ${this.#formatNumber(military.tanks)} • ✈️ ${this.#formatNumber(military.aircraft)} • 🚢 ${this.#formatNumber(military.ships)} • 🕵️ ${this.#formatNumber(military.spies)} • 🎯 ${this.#formatNumber(military.missiles)} • ☢️ ${this.#formatNumber(military.nukes)}`;
    });

    return this.#chunkDiscordMessage([headerParts.join(' | '), ...lines].join('\n'));
  }

  #buildBeigeExitEmbed(command) {
    const payload = command?.payload ?? {};
    const nation = payload.nation ?? {};
    const createdAt = this.#parseDate(command?.created_at) ?? new Date();
    const detectedAt = this.#parseDate(payload.detected_at) ?? createdAt;
    const nationLabel = nation.nation_name ?? 'Unknown nation';
    const leader = nation.leader_name ?? 'Unknown leader';
    const declareWarUrl = this.#buildDeclareWarUrl(nation.id);
    const declareWarLink = declareWarUrl ? `[Open Declare War Page](${declareWarUrl})` : 'Unavailable';

    const embed = new EmbedBuilder()
      .setTitle('🟨 Beige Exit Alert')
      .setColor(0xd4b06a)
      .setDescription(`**${leader}** of **${nationLabel}** is no longer beige.`)
      .setTimestamp(detectedAt)
      .addFields(
        {
          name: 'Nation',
          value: `${nation.links?.nation ? `[${nationLabel}](${nation.links.nation})` : nationLabel}\nLeader: ${leader}`,
          inline: true,
        },
        {
          name: 'Alliance',
          value: this.#formatAllianceWithLink(nation),
          inline: true,
        },
        {
          name: 'Stats',
          value: `Score: ${this.#formatNumber(nation.score)}\nCities: ${this.#formatNumber(nation.cities)}\nPrevious Beige Turns: ${this.#formatNumber(payload.previous_beige_turns ?? 0)}`,
          inline: true,
        },
        {
          name: 'Military Snapshot',
          value: this.#formatMilitaryMultiline(nation.military),
        },
        {
          name: 'Detected',
          value: `${this.#formatDiscordTime(detectedAt, 'f')} (${this.#formatDiscordTime(detectedAt, 'R')})`,
        },
        {
          name: 'War Link',
          value: `⚔️ ${declareWarLink}`,
        },
      )
      .setFooter({ text: `Event: ${payload.event_type ?? 'beige_exit'}` });

    if (nation.links?.nation) {
      embed.setURL(nation.links.nation);
    }

    return embed;
  }

  #formatAllianceWithLink(nation = {}) {
    const alliance = nation.alliance ?? {};
    const name = alliance.name ?? 'No alliance';
    const link = nation.links?.alliance ?? null;

    return link ? `[${name}](${link})` : name;
  }

  #formatMilitaryMultiline(military = {}) {
    return [
      `🪖 Soldiers: ${this.#formatNumber(military.soldiers)}`,
      `🛡️ Tanks: ${this.#formatNumber(military.tanks)}`,
      `✈️ Aircraft: ${this.#formatNumber(military.aircraft)}`,
      `🚢 Ships: ${this.#formatNumber(military.ships)}`,
      `🕵️ Spies: ${this.#formatNumber(military.spies)}`,
      `🎯 Missiles: ${this.#formatNumber(military.missiles)}`,
      `☢️ Nukes: ${this.#formatNumber(military.nukes)}`,
    ].join('\n');
  }

  #describeBeigeEvent(eventType, window) {
    if (eventType === 'upcoming_turn_exit') {
      return 'Expected exits this turn';
    }

    if (eventType === 'turn_exit') {
      return 'Exited this turn';
    }

    if (eventType === 'early_exit') {
      return 'Early beige exits';
    }

    if (window === 'pre_turn') {
      return 'Pre-turn beige status';
    }

    if (window === 'post_turn') {
      return 'Post-turn beige status';
    }

    return 'Beige status update';
  }

  #chunkDiscordMessage(text, maxLength = 1900) {
    if (typeof text !== 'string' || text.length <= maxLength) {
      return [text];
    }

    const lines = text.split('\n');
    const chunks = [];
    let currentChunk = '';

    for (const line of lines) {
      if (!line) {
        continue;
      }

      const withNewline = currentChunk ? `${currentChunk}\n${line}` : line;
      if (withNewline.length <= maxLength) {
        currentChunk = withNewline;
        continue;
      }

      if (currentChunk) {
        chunks.push(currentChunk);
      }

      if (line.length > maxLength) {
        for (let i = 0; i < line.length; i += maxLength) {
          chunks.push(line.slice(i, i + maxLength));
        }
        currentChunk = '';
      } else {
        currentChunk = line;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  #buildDeclareWarUrl(nationId) {
    const normalizedId = Number(nationId);

    if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
      return null;
    }

    return `https://politicsandwar.com/nation/war/declare/id=${normalizedId}`;
  }

  #buildWarRoomName(payload = {}) {
    const suggested = typeof payload.room_name_suggestion === 'string' ? payload.room_name_suggestion : null;
    const leader = payload?.target?.leader_name ?? null;
    const sourceType = payload?.source?.type ?? 'war';
    const sourceId = payload?.source?.id ?? null;

    let base = suggested ?? `${sourceType}-${sourceId ?? 'target'}-${leader ?? payload?.target?.id ?? 'room'}`;

    base = base
      .toLowerCase()
      .replace(/[^a-z0-9-_ ]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    if (!base) {
      base = `war-room-${Date.now()}`;
    }

    return base.slice(0, 100);
  }

  #buildWarRoomMentions(assignedMembers) {
    if (!Array.isArray(assignedMembers) || assignedMembers.length === 0) {
      return [];
    }

    const unique = new Set();

    for (const member of assignedMembers) {
      const mention =
        member?.mention ??
        (member?.discord_id && `${member.discord_id}`.trim() !== '' ? `<@${member.discord_id}>` : null);

      if (mention) {
        unique.add(mention);
      }
    }

    return Array.from(unique);
  }

  #buildWarRoomEmbed(command) {
    const payload = command?.payload ?? {};
    const target = payload.target ?? {};
    const links = payload.links ?? {};
    const createdAt = this.#parseDate(command?.created_at) ?? new Date();
    const attackType = payload?.attack_type?.label ?? payload?.attack_type?.key ?? 'Unspecified';
    const sourceType = payload?.source?.type ?? 'war_plan';
    const sourceId = payload?.source?.id ?? null;

    const sourceLabel = sourceId ? `${sourceType} #${sourceId}` : sourceType;
    const sourceLink = payload?.source?.url ? `[${sourceLabel}](${payload.source.url})` : sourceLabel;
    const targetNationName = target.nation_name ?? 'Unknown nation';
    const targetLeader = target.leader_name ?? 'Unknown leader';
    const targetNationLink = links.target_nation
      ? `[${targetNationName}](${links.target_nation})`
      : targetNationName;

    const objectiveLines = [];
    if (links.declare_war) {
      objectiveLines.push(`⚔️ [Declare War](${links.declare_war})`);
    }
    if (links.war_simulators) {
      objectiveLines.push(`🧪 [War Simulators](${links.war_simulators})`);
    }
    if (payload.source?.url) {
      objectiveLines.push(`🧭 [Source Plan](${payload.source.url})`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`⚔️ Target Brief: ${targetLeader}`)
      .setColor(0xb02e26)
      .setDescription(
        [
          `**Target:** ${targetNationLink} (${targetLeader})`,
          `**Attack Type:** ${attackType}`,
          `**Source:** ${sourceLink}`,
          objectiveLines.length > 0 ? `\n${objectiveLines.join(' • ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .addFields(
        {
          name: 'Alliance',
          value: this.#formatWarRoomAlliance(target.alliance),
          inline: true,
        },
        {
          name: 'Score / Cities',
          value: `${this.#formatNumber(target.score)} / ${this.#formatNumber(target.cities)}`,
          inline: true,
        },
        {
          name: 'War Loadout',
          value: `Off: ${this.#formatNumber(target.offensive_wars)} | Def: ${this.#formatNumber(
            target.defensive_wars,
          )} | Beige Turns: ${this.#formatNumber(target.beige_turns)}`,
          inline: true,
        },
        {
          name: 'Military Snapshot',
          value: this.#formatMilitaryMultiline(target.military),
        },
      )
      .setFooter({ text: 'Nexus AMS War Room' })
      .setTimestamp(createdAt);

    if (links.target_nation) {
      embed.setURL(links.target_nation);
    }

    return embed;
  }

  #formatWarRoomAlliance(alliance = {}) {
    const name = alliance?.name ?? 'No alliance';
    const acronym = alliance?.acronym ? ` (${alliance.acronym})` : '';

    return `${name}${acronym}`;
  }

  #buildWarRoomAssignmentMessages(assignedMembers) {
    if (!Array.isArray(assignedMembers) || assignedMembers.length === 0) {
      return ['No assigned friendly nations were provided for this target.'];
    }

    const header = '### Friendly Assignments';
    const lines = assignedMembers.map((member, index) => {
      const leader = member?.leader_name ?? 'Unknown leader';
      const nationName = member?.nation_name ?? 'Unknown nation';
      const nationLink = member?.links?.nation ? `[${nationName}](${member.links.nation})` : nationName;
      const mention =
        member?.mention ??
        (member?.discord_id && `${member.discord_id}`.trim() !== '' ? `<@${member.discord_id}>` : null) ??
        'No Discord link';

      return `${index + 1}. ${mention} | ${nationLink} (${leader}) | Match: ${this.#formatNumber(
        member?.match_score,
      )} | Score: ${this.#formatNumber(member?.score)} | Cities: ${this.#formatNumber(
        member?.cities,
      )} | Wars O/D: ${this.#formatNumber(member?.offensive_wars)}/${this.#formatNumber(member?.defensive_wars)}`;
    });

    return this.#chunkDiscordMessage([header, ...lines].join('\n'));
  }

  #buildWarRoomMentionMessages(mentions = []) {
    if (!Array.isArray(mentions) || mentions.length === 0) {
      return ['### Assigned Friendlies\nNo Discord mentions available for this target.'];
    }

    const messages = [];
    let current = '### Assigned Friendlies\n';

    for (const mention of mentions) {
      const token = `${mention} `;
      if ((current + token).length <= 1900) {
        current += token;
        continue;
      }

      messages.push(current.trimEnd());
      current = `### Assigned Friendlies\n${token}`;
    }

    if (current.trim().length > 0) {
      messages.push(current.trimEnd());
    }

    return messages;
  }

  async #withDiscordRetry(operation, label, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryAfterSeconds =
          Number(error?.retry_after ?? error?.rawError?.retry_after ?? error?.data?.retry_after ?? NaN);
        const shouldRetry = attempt < maxAttempts && !Number.isNaN(retryAfterSeconds);

        if (!shouldRetry) {
          throw error;
        }

        const waitMs = Math.max(Math.ceil(retryAfterSeconds * 1000), 1000);
        this.logger.warn(`Rate-limited while trying to ${label}; retrying in ${waitMs}ms`, {
          attempt,
          maxAttempts,
        });
        await this.#sleep(waitMs);
      }
    }

    return null;
  }

  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
