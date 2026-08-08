import { createHash } from 'node:crypto';
import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';

/** Shared Discord mechanics for queue action modules. */
export class QueueActionRuntime {
  constructor({ client, logger, guildId, apiService = null }) {
    this.client = client;
    this.logger = logger;
    this.guildId = guildId;
    this.apiService = apiService;
  }

  forExecution(execution = {}) {
    const scoped = Object.create(this);
    scoped.execution = execution;
    return scoped;
  }

  canContinue() {
    return !this.execution.canContinue || this.execution.canContinue();
  }

  async resolveTextChannel(channelId) {
    if (!isDiscordSnowflake(channelId)) {
      return null;
    }

    const cached = this.client.channels.cache.get(channelId);
    if (cached?.isTextBased?.() && cached.guildId === this.guildId) {
      return cached;
    }

    try {
      const fetched = await this.client.channels.fetch(channelId);
      return fetched?.isTextBased?.() && fetched.guildId === this.guildId ? fetched : null;
    } catch (error) {
      this.logger.warn('Channel fetch failed or inaccessible', {
        channelId,
        error: error?.message ?? error,
      });
      return null;
    }
  }

  async resolveChannel(channelId) {
    const result = await this.resolveChannelWithError(channelId);
    return result.value;
  }

  async resolveChannelWithError(channelId) {
    if (!isDiscordSnowflake(channelId)) {
      return { value: null, error: null };
    }

    const cached = this.client.channels.cache.get(channelId);
    if (cached?.guildId === this.guildId) {
      return { value: cached, error: null };
    }

    try {
      const fetched = await this.client.channels.fetch(channelId);
      if (fetched?.guildId !== this.guildId) return { value: null, error: null };
      return { value: fetched, error: null };
    } catch (error) {
      this.logger.warn('Channel fetch failed or inaccessible', {
        channelId,
        error: error?.message ?? error,
      });
      return { value: null, error };
    }
  }

  async resolveGuild() {
    if (!isDiscordSnowflake(this.guildId)) {
      this.logger.warn('Queue dispatcher missing a valid guildId; cannot resolve guild.');
      return null;
    }

    const cached = this.client.guilds.cache.get(this.guildId);
    if (cached) {
      return cached;
    }

    try {
      return (await this.client.guilds.fetch(this.guildId)) ?? null;
    } catch (error) {
      this.logger.warn('Guild fetch failed or inaccessible', {
        guildId: this.guildId,
        error: error?.message ?? error,
      });
      return null;
    }
  }

  async resolveUser(userId) {
    const result = await this.resolveUserWithError(userId);
    return result.value;
  }

  async resolveUserWithError(userId) {
    if (!isDiscordSnowflake(userId)) return { value: null, error: null };
    const cached = this.client.users?.cache?.get?.(userId);
    if (cached) return { value: cached, error: null };
    try {
      return { value: (await this.client.users?.fetch?.(userId)) ?? null, error: null };
    } catch (error) {
      this.logger.warn('User fetch failed or inaccessible', {
        userId,
        errorCode: error?.code ?? null,
      });
      return { value: null, error };
    }
  }

  async send(channel, command, stepKey, payload, label) {
    return this.withDiscordRetry(
      () => channel.send(this.messagePayload(command, stepKey, payload)),
      label,
    );
  }

  async sendDirectMessage(user, command, stepKey, payload, label) {
    return this.withDiscordRetry(
      () => user.send(this.messagePayload(command, stepKey, payload)),
      label,
    );
  }

  async createForumThread(forum, command, stepKey, options, label) {
    const message = this.messagePayload(command, stepKey, options.message);
    return this.withDiscordRetry(
      () => forum.threads.create({ ...options, message }),
      label,
    );
  }

  messagePayload(command, stepKey, payload) {
    const nonce = createHash('sha256')
      .update(`${command?.id ?? 'unknown'}:${stepKey}`)
      .digest('hex')
      .slice(0, 23);

    return {
      ...payload,
      allowedMentions: payload.allowedMentions ?? { parse: [], repliedUser: false },
      nonce,
      enforceNonce: true,
    };
  }

  async withDiscordRetry(operation, label, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryAfterSeconds = Number(
          error?.retry_after ?? error?.rawError?.retry_after ?? error?.data?.retry_after ?? NaN,
        );
        const shouldRetry = attempt < maxAttempts && !Number.isNaN(retryAfterSeconds);
        if (!shouldRetry) {
          throw error;
        }

        const waitMs = Math.max(Math.ceil(retryAfterSeconds * 1000), 1000);
        this.logger.warn(`Rate-limited while trying to ${label}; retrying in ${waitMs}ms`, {
          attempt,
          maxAttempts,
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    return null;
  }
}

export const extractUserSnowflakes = (content) => {
  const ids = new Set();
  for (const match of `${content ?? ''}`.matchAll(/<@(\d{17,20})>/g)) {
    if (isDiscordSnowflake(match[1])) {
      ids.add(match[1]);
    }
  }
  return Array.from(ids);
};
