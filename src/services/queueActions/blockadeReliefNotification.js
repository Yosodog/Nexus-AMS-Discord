import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';
import {
  buildEmbed,
  formatDiscordTime,
  markdownLink,
  nationUrl,
  resolveDeepLink,
} from '../../utils/discordUi.js';

const EVENTS = Object.freeze({
  created: { title: 'Blockade Relief Requested', color: 0xfee75c, detail: 'A new alliance blockade relief request is available.' },
  claimed: { title: 'Blockade Relief Claimed', color: 0x57f287, detail: 'The blockade relief request has been claimed.' },
  reopened: { title: 'Blockade Relief Reopened', color: 0xfee75c, detail: 'The previous helper is no longer eligible, so the request is open again.' },
  resolved: { title: 'Blockade Relief Resolved', color: 0x57f287, detail: 'The blockade or war has ended.' },
  cancelled: { title: 'Blockade Relief Cancelled', color: 0x747f8d, detail: 'The requester cancelled this relief request.' },
  expired: { title: 'Blockade Relief Expired', color: 0xed4245, detail: 'The relief deadline passed before resolution.' },
});

const boundedName = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 120;

export const validate = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { valid: false, reason: 'invalid_payload' };
  if (payload.contract_version !== 1) return { valid: false, reason: 'unsupported_contract_version' };
  if (!EVENTS[payload.event_type]) return { valid: false, reason: 'invalid_event_type' };
  if (!Number.isSafeInteger(payload.request_id) || payload.request_id < 1) return { valid: false, reason: 'invalid_request_id' };
  if (!Number.isSafeInteger(payload.war_id) || payload.war_id < 1) return { valid: false, reason: 'invalid_war_id' };
  if (!Array.isArray(payload.recipient_discord_ids) || payload.recipient_discord_ids.length < 1
    || payload.recipient_discord_ids.length > 10 || payload.recipient_discord_ids.some((id) => !isDiscordSnowflake(id))) {
    return { valid: false, reason: 'invalid_recipients' };
  }
  if (!payload.requester || !Number.isSafeInteger(payload.requester.id) || payload.requester.id < 1
    || (payload.requester.name !== null && payload.requester.name !== undefined && !boundedName(payload.requester.name))) {
    return { valid: false, reason: 'invalid_requester' };
  }
  if (!payload.blockader || !Number.isSafeInteger(payload.blockader.id) || payload.blockader.id < 1
    || (payload.blockader.name !== null && payload.blockader.name !== undefined && !boundedName(payload.blockader.name))) {
    return { valid: false, reason: 'invalid_blockader' };
  }
  if (typeof payload.deadline_at !== 'string' || Number.isNaN(Date.parse(payload.deadline_at))) {
    return { valid: false, reason: 'invalid_deadline' };
  }
  if (payload.deep_link_path !== '/defense/blockade-relief') return { valid: false, reason: 'invalid_deep_link' };
  return { valid: true };
};

export const execute = async (command, runtime) => {
  const payload = command.payload;
  const template = EVENTS[payload.event_type];
  const requester = payload.requester.name ?? `Nation #${payload.requester.id}`;
  const blockader = payload.blockader.name ?? `Nation #${payload.blockader.id}`;
  const deepLink = resolveDeepLink(runtime.apiService?.baseUrl, payload.deep_link_path);
  const embed = buildEmbed({
    title: template.title,
    color: template.color,
    description: `${template.detail}${deepLink ? `\n${markdownLink('Open in Nexus', deepLink)}` : ''}`,
    fields: [
      {
        name: 'Nations',
        value: `**Requester:** ${markdownLink(requester, nationUrl({ id: payload.requester.id }))}\n**Blockader:** ${markdownLink(blockader, nationUrl({ id: payload.blockader.id }))}`,
      },
      {
        name: 'War and deadline',
        value: `${markdownLink(`War #${payload.war_id}`, `https://politicsandwar.com/nation/war/timeline/war=${payload.war_id}`)}\n${formatDiscordTime(payload.deadline_at)} (${formatDiscordTime(payload.deadline_at, 'f')})`,
      },
    ],
    footer: deepLink ? null : `Nexus path: ${payload.deep_link_path}`,
    url: deepLink,
  });
  let delivered = 0;
  let undeliverable = 0;

  for (const recipientId of [...new Set(payload.recipient_discord_ids)]) {
    if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
    const user = await runtime.resolveUser(recipientId);
    if (!user) {
      undeliverable += 1;
      continue;
    }
    try {
      await runtime.sendDirectMessage(user, command, `blockade-relief-${recipientId}`, {
        embeds: [embed], allowedMentions: { parse: [], repliedUser: false },
      }, 'send blockade relief notification');
      delivered += 1;
    } catch (error) {
      undeliverable += 1;
      runtime.logger.warn('Blockade relief notification could not be delivered', {
        commandId: command.id ?? null, recipientId, errorCode: error?.code ?? null,
      });
    }
  }

  return { success: true, result: { delivered, undeliverable } };
};
