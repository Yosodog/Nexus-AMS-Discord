import { PHASE2_CAPABILITY_KEYS, registeredQueueActions } from '../connection/Capabilities.js';

const PERMISSION_NAMES = Object.freeze({
  Administrator: 'administrator',
  ManageGuild: 'manage_guild',
  ManageChannels: 'manage_channels',
  ManageRoles: 'manage_roles',
  SendMessages: 'send_messages',
  EmbedLinks: 'embed_links',
  ReadMessageHistory: 'read_message_history',
  ViewChannel: 'view_channel',
});

const safeNumber = (value) => (Number.isSafeInteger(Number(value)) ? Number(value) : null);

const observedPermissions = (guild) => {
  const permissions = guild?.members?.me?.permissions;
  if (!permissions) return { observed: false, granted: [] };
  const granted = Object.entries(PERMISSION_NAMES)
    .filter(([name]) => permissions.has?.(name) === true)
    .map(([, value]) => value);
  return { observed: true, granted };
};

const redact = (value, seen = new WeakSet()) => {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|private|password|authorization|cookie|api.?key|signature|payload|content|body/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redact(entry, seen);
    }
  }
  return output;
};

/** Read-only bot observations for /nexus status; never returns credentials or message content. */
export class DiscordStatusService {
  constructor({ client, connectionResolver, config = {}, queueWorkers = [], now = Date.now } = {}) {
    this.client = client;
    this.connectionResolver = connectionResolver;
    this.config = config;
    this.queueWorkers = queueWorkers;
    this.now = now;
  }

  getStatus({ guildId = null } = {}) {
    const guild = guildId ? this.client?.guilds?.cache?.get?.(guildId) : null;
    const gatewayStatus = safeNumber(this.client?.ws?.status);
    const workers = typeof this.queueWorkers === 'function' ? this.queueWorkers() : this.queueWorkers;
    const queue = (workers ?? []).map((worker) => worker.getHealthSnapshot?.() ?? {})
      .filter((snapshot) => snapshot && typeof snapshot === 'object');

    return redact({
      generated_at: new Date(this.now()).toISOString(),
      gateway: {
        ready: Boolean(this.client?.isReady?.() ?? this.client?.readyAt),
        status: gatewayStatus,
        shard_id: safeNumber(this.client?.shard?.ids?.[0]),
        guild_count: this.client?.guilds?.cache?.size ?? 0,
      },
      intents: {
        configured: this.config?.discord?.intents?.names ?? [],
        message_content: Boolean(this.config?.discord?.intents?.messageContent),
        guild_members: Boolean(this.config?.discord?.intents?.guildMembers),
      },
      capabilities: {
        supported: PHASE2_CAPABILITY_KEYS,
        reads_legacy_queue_lanes: true,
        supported_queue_actions: registeredQueueActions(),
      },
      discord: {
        guild_id: guildId,
        observed: Boolean(guild),
        permissions: observedPermissions(guild),
      },
      routing: this.connectionResolver?.diagnostics?.() ?? {
        mode: this.config?.discord?.deploymentMode ?? 'unknown',
        active_connections: 0,
      },
      queue,
    });
  }
}

export { redact as redactStatus };
