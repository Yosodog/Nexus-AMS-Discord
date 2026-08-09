import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ApiContractError, ApiService, RetryMode } from '../src/services/ApiService.js';
import { DiscordRelaySigner } from '../src/services/DiscordRelaySigner.js';
import { createLogger } from './helpers.js';

const GUILD_ID = '223456789012345678';
const ACTOR = {
  discordUserId: '123456789012345678',
  discordGuildId: GUILD_ID,
  discordInteractionId: '323456789012345678',
  discordCommand: 'contract.test',
};
const { privateKey: relayPrivateKey } = generateKeyPairSync('ed25519');
const relayPrivateKeyBase64 = relayPrivateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

function createApiService(options = {}) {
  return new ApiService({
    baseUrl: 'https://nexus.example',
    apiKey: 'secret-key',
    logger: createLogger(),
    relaySigner: new DiscordRelaySigner({
      privateKeyBase64: relayPrivateKeyBase64,
      guildId: GUILD_ID,
      clock: () => 1_700_000_000_000,
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
    }),
    maxRetries: 1,
    ...options,
  });
}

const endpointCases = [
  {
    name: 'getContext',
    invoke: (service) => service.getContext(ACTOR),
    method: 'get',
    pathname: '/api/v1/discord/context',
    relay: 'actor',
  },
  {
    name: 'getMySummary',
    invoke: (service) => service.getMySummary(ACTOR),
    method: 'get',
    pathname: '/api/v1/discord/me/summary',
    relay: 'actor',
  },
  {
    name: 'getMyAccounts',
    invoke: (service) => service.getMyAccounts(ACTOR, {
      account: 'account / primary', query: 'main & reserve', limit: 25, page: 4, unsupported: 'ignored',
    }),
    method: 'get',
    pathname: '/api/v1/discord/me/accounts',
    query: { account: 'account / primary', query: 'main & reserve', limit: '25' },
    relay: 'actor',
  },
  {
    name: 'createDepositRequest',
    invoke: (service) => service.createDepositRequest(ACTOR, 'account / primary', { amount: '100.00' }),
    method: 'post',
    pathname: '/api/v1/discord/me/accounts/account%20%2F%20primary/deposit-requests',
    body: { amount: '100.00' },
    relay: 'actor',
  },
  {
    name: 'createWithdrawalDraft',
    invoke: (service) => service.createWithdrawalDraft(ACTOR, { account_id: 2, amount: '50.00' }),
    method: 'post', pathname: '/api/v1/discord/me/withdrawals/drafts',
    body: { account_id: 2, amount: '50.00' }, relay: 'actor',
  },
  {
    name: 'getWithdrawalIntent',
    invoke: (service) => service.getWithdrawalIntent(ACTOR, 'intent / one'),
    method: 'get', pathname: '/api/v1/discord/me/withdrawals/intent%20%2F%20one', relay: 'actor',
  },
  {
    name: 'confirmWithdrawal',
    invoke: (service) => service.confirmWithdrawal(ACTOR, 'intent / two'),
    method: 'post', pathname: '/api/v1/discord/me/withdrawals/intent%20%2F%20two/confirm', body: {}, relay: 'actor',
  },
  {
    name: 'cancelWithdrawal',
    invoke: (service) => service.cancelWithdrawal(ACTOR, 'intent / three'),
    method: 'post', pathname: '/api/v1/discord/me/withdrawals/intent%20%2F%20three/cancel', body: {}, relay: 'actor',
  },
  {
    name: 'getMyTransactions',
    invoke: (service) => service.getMyTransactions(ACTOR, {
      account: 'account / primary', type: 'deposit', status: 'complete', page: 3, per_page: 15, scope: 'ignored',
    }),
    method: 'get',
    pathname: '/api/v1/discord/me/accounts/account%20%2F%20primary/transactions',
    query: { type: 'deposit', status: 'complete', page: '3', per_page: '15' },
    relay: 'actor',
  },
  {
    name: 'getMyRequests',
    invoke: (service) => service.getMyRequests(ACTOR, {
      type: 'grant', status: 'open', scope: 'mine', page: 9, limit: 50,
    }),
    method: 'get', pathname: '/api/v1/discord/me/requests',
    query: { type: 'grant', status: 'open' }, relay: 'actor',
  },
  {
    name: 'getGrantPrograms',
    invoke: (service) => service.getGrantPrograms(ACTOR, {
      eligible_only: true, query: 'city', limit: 10, page: 2,
    }),
    method: 'get', pathname: '/api/v1/discord/me/grants',
    query: { eligible_only: 'true', query: 'city', limit: '10' }, relay: 'actor',
  },
  {
    name: 'previewGrantApplication',
    invoke: (service) => service.previewGrantApplication(ACTOR, { program_id: 4 }),
    method: 'post', pathname: '/api/v1/discord/me/grant-applications/preview', body: { program_id: 4 }, relay: 'actor',
  },
  {
    name: 'confirmGrantApplication',
    invoke: (service) => service.confirmGrantApplication(ACTOR, { intent_id: 'grant-intent' }),
    method: 'post', pathname: '/api/v1/discord/me/grant-applications/confirm', body: { intent_id: 'grant-intent' }, relay: 'actor',
  },
  {
    name: 'previewCityGrantRequest',
    invoke: (service) => service.previewCityGrantRequest(ACTOR, { city: 30 }),
    method: 'post', pathname: '/api/v1/discord/me/city-grant-requests/preview', body: { city: 30 }, relay: 'actor',
  },
  {
    name: 'confirmCityGrantRequest',
    invoke: (service) => service.confirmCityGrantRequest(ACTOR, { intent_id: 'city-intent' }),
    method: 'post', pathname: '/api/v1/discord/me/city-grant-requests/confirm', body: { intent_id: 'city-intent' }, relay: 'actor',
  },
  {
    name: 'getMyGrantRequests',
    invoke: (service) => service.getMyGrantRequests(ACTOR, { status: 'open', type: 'loan', scope: 'ignored', page: 2 }),
    method: 'get', pathname: '/api/v1/discord/me/requests',
    query: { type: 'grant', status: 'open' }, relay: 'actor',
  },
  {
    name: 'previewLoanApplication',
    invoke: (service) => service.previewLoanApplication(ACTOR, { amount: '1000.00' }),
    method: 'post', pathname: '/api/v1/discord/me/loan-applications/preview', body: { amount: '1000.00' }, relay: 'actor',
  },
  {
    name: 'confirmLoanApplication',
    invoke: (service) => service.confirmLoanApplication(ACTOR, { intent_id: 'loan-intent' }),
    method: 'post', pathname: '/api/v1/discord/me/loan-applications/confirm', body: { intent_id: 'loan-intent' }, relay: 'actor',
  },
  {
    name: 'getMyLoans',
    invoke: (service) => service.getMyLoans(ACTOR, { query: 'ignored', loan: 'ignored', limit: 25 }),
    method: 'get', pathname: '/api/v1/discord/me/loans', relay: 'actor',
  },
  {
    name: 'previewLoanPayment',
    invoke: (service) => service.previewLoanPayment(ACTOR, { loan_id: 3, amount: '25.00' }),
    method: 'post', pathname: '/api/v1/discord/me/loan-payments/preview', body: { loan_id: 3, amount: '25.00' }, relay: 'actor',
  },
  {
    name: 'confirmLoanPayment',
    invoke: (service) => service.confirmLoanPayment(ACTOR, { intent_id: 'payment-intent' }),
    method: 'post', pathname: '/api/v1/discord/me/loan-payments/confirm', body: { intent_id: 'payment-intent' }, relay: 'actor',
  },
  {
    name: 'createWarAidDraft',
    invoke: (service) => service.createWarAidDraft(ACTOR, { amount: '500.00' }),
    method: 'post', pathname: '/api/v1/discord/me/war-aid/draft', body: { amount: '500.00' }, relay: 'actor',
  },
  {
    name: 'reviewWarAidDraft',
    invoke: (service) => service.reviewWarAidDraft(ACTOR, { intent_id: 'war-aid' }),
    method: 'post', pathname: '/api/v1/discord/me/war-aid/review', body: { intent_id: 'war-aid' }, relay: 'actor',
  },
  {
    name: 'confirmWarAidRequest',
    invoke: (service) => service.confirmWarAidRequest(ACTOR, { intent_id: 'war-aid' }),
    method: 'post', pathname: '/api/v1/discord/me/war-aid/confirm', body: { intent_id: 'war-aid' }, relay: 'actor',
  },
  {
    name: 'getMyWarAidRequests',
    invoke: (service) => service.getMyWarAidRequests(ACTOR, { status: 'ignored', page: 2 }),
    method: 'get', pathname: '/api/v1/discord/me/war-aid', relay: 'actor',
  },
  {
    name: 'confirmRebuildRequest',
    invoke: (service) => service.confirmRebuildRequest(ACTOR, { account_id: 2, note: 'Rebuild' }),
    method: 'post', pathname: '/api/v1/discord/me/rebuilding/confirm', body: { account_id: 2, note: 'Rebuild' }, relay: 'actor',
  },
  {
    name: 'previewRebuildRequest',
    invoke: (service) => service.previewRebuildRequest(ACTOR, { account_id: 2, note: 'ignored by provider' }),
    method: 'get', pathname: '/api/v1/discord/me/rebuilding/preview', relay: 'actor',
  },
  {
    name: 'getMyRebuildRequests',
    invoke: (service) => service.getMyRebuildRequests(ACTOR, { status: 'open', type: 'loan', scope: 'ignored', page: 3 }),
    method: 'get', pathname: '/api/v1/discord/me/requests',
    query: { type: 'rebuilding', status: 'open' }, relay: 'actor',
  },
  {
    name: 'getMyRaidAssignments',
    invoke: (service) => service.getMyRaidAssignments(ACTOR, {
      nation_id: 99, sort: 'value', limit: 10, query: 'ignored', page: 4,
    }),
    method: 'get', pathname: '/api/v1/discord/me/raids',
    query: { nation_id: '99', sort: 'value', limit: '10' }, relay: 'actor',
  },
  {
    name: 'getMyWarAssignments',
    invoke: (service) => service.getMyWarAssignments(ACTOR, { status: 'ignored' }),
    method: 'get', pathname: '/api/v1/discord/me/war-assignments', relay: 'actor',
  },
  {
    name: 'getMyActiveWars',
    invoke: (service) => service.getMyActiveWars(ACTOR, { query: 'ignored', limit: 25 }),
    method: 'get', pathname: '/api/v1/discord/me/wars', relay: 'actor',
  },
  {
    name: 'respondToWarAssignment',
    invoke: (service) => service.respondToWarAssignment(ACTOR, 'plan', 'plan / 7', { response: 'acknowledged' }),
    method: 'post', pathname: '/api/v1/discord/me/war-assignments/plan/plan%20%2F%207/response',
    body: { response: 'acknowledged' }, relay: 'actor',
  },
  {
    name: 'getWarCounterRecommendation',
    invoke: (service) => service.getWarCounterRecommendation(ACTOR, 9),
    method: 'get', pathname: '/api/v1/discord/me/wars/counter', query: { nation_id: '9' }, relay: 'actor',
  },
  {
    name: 'getWarSimulation',
    invoke: (service) => service.getWarSimulation(ACTOR, 'war / 11'),
    method: 'get', pathname: '/api/v1/discord/me/wars/war%20%2F%2011/simulation', relay: 'actor',
  },
  {
    name: 'getMySpyAssignments',
    invoke: (service) => service.getMySpyAssignments(ACTOR, { query: 'ignored', page: 2 }),
    method: 'get', pathname: '/api/v1/discord/me/spy-assignments', relay: 'actor',
  },
  {
    name: 'getMyAuditFindings',
    invoke: (service) => service.getMyAuditFindings(ACTOR),
    method: 'get', pathname: '/api/v1/discord/me/audits', relay: 'actor',
  },
  {
    name: 'acknowledgeAuditFinding',
    invoke: (service) => service.acknowledgeAuditFinding(ACTOR, 'finding / 5', { note: 'Reviewed' }),
    method: 'post', pathname: '/api/v1/discord/me/audits/finding%20%2F%205/acknowledge',
    body: { note: 'Reviewed' }, relay: 'actor',
  },
  {
    name: 'snoozeAuditFinding',
    invoke: (service) => service.snoozeAuditFinding(ACTOR, 'finding / 6', { until: 'tomorrow' }),
    method: 'post', pathname: '/api/v1/discord/me/audits/finding%20%2F%206/snooze',
    body: { until: 'tomorrow' }, relay: 'actor',
  },
  {
    name: 'getStaffApplications',
    invoke: (service) => service.getStaffApplications(ACTOR, {
      status: 'pending', filter: 'mine', query: 'alice', applicant_discord_id: '423456789012345678',
      discord_channel_id: '523456789012345678', limit: 25, scope: 'ignored', page: 8,
    }),
    method: 'get', pathname: '/api/v1/discord/staff/applications',
    query: {
      status: 'pending', filter: 'mine', query: 'alice', applicant_discord_id: '423456789012345678',
      discord_channel_id: '523456789012345678', limit: '25',
    },
    relay: 'actor',
  },
  {
    name: 'getMyApplications',
    invoke: (service) => service.getMyApplications(ACTOR, { status: 'ignored', query: 'ignored' }),
    method: 'get', pathname: '/api/v1/discord/me/applications', relay: 'actor',
  },
  {
    name: 'getStaffApplicationReview',
    invoke: (service) => service.getStaffApplicationReview(ACTOR, { application: 'application / 12', page: 2 }),
    method: 'get', pathname: '/api/v1/discord/staff/applications/application%20%2F%2012', relay: 'actor',
  },
  {
    name: 'decideStaffApplication',
    invoke: (service) => service.decideStaffApplication(ACTOR, 'application / 12', 'approve', { note: 'Approved' }),
    method: 'post', pathname: '/api/v1/discord/staff/applications/application%20%2F%2012/approve',
    body: { note: 'Approved' }, relay: 'actor',
  },
  {
    name: 'getStaffRequests',
    invoke: (service) => service.getStaffRequests(ACTOR, {
      type: 'grant', status: 'open', limit: 20, scope: 'staff-queue', page: 2,
    }),
    method: 'get', pathname: '/api/v1/discord/staff/requests',
    query: { type: 'grant', status: 'open', limit: '20' }, relay: 'actor',
  },
  {
    name: 'getStaffWorkItems',
    invoke: (service) => service.getStaffWorkItems(ACTOR, {
      q: 'blocked loan', type: 'loans', priority: 'p1', severity: 'high', urgency: 'urgent',
      blocked: true, freshness: 'fresh', sort: 'age', direction: 'desc', page: 2, per_page: 10,
      status: 'ignored', limit: 100,
    }),
    method: 'get', pathname: '/api/v1/discord/staff/work-items',
    query: {
      q: 'blocked loan', type: 'loans', priority: 'p1', severity: 'high', urgency: 'urgent',
      blocked: 'true', freshness: 'fresh', sort: 'age', direction: 'desc', page: '2', per_page: '10',
    },
    relay: 'actor',
  },
  {
    name: 'getStaffWorkItem',
    invoke: (service) => service.getStaffWorkItem(ACTOR, 'loan reviews', 'loan / 42'),
    method: 'get', pathname: '/api/v1/discord/staff/work-items/loan%20reviews/loan%20%2F%2042', relay: 'actor',
  },
  {
    name: 'getMyAlerts',
    invoke: (service) => service.getMyAlerts(ACTOR),
    method: 'get', pathname: '/api/v1/discord/me/alerts', relay: 'actor',
  },
  {
    name: 'createAlert',
    invoke: (service) => service.createAlert(ACTOR, { type: 'nation', target_id: 7 }),
    method: 'post', pathname: '/api/v1/discord/me/alerts', body: { type: 'nation', target_id: 7 }, relay: 'actor',
  },
  {
    name: 'updateAlertStatus',
    invoke: (service) => service.updateAlertStatus(ACTOR, 'alert / 7', false),
    method: 'patch', pathname: '/api/v1/discord/me/alerts/alert%20%2F%207/status',
    body: { is_active: false }, relay: 'actor',
  },
  {
    name: 'testAlert',
    invoke: (service) => service.testAlert(ACTOR, 'alert / 8'),
    method: 'post', pathname: '/api/v1/discord/me/alerts/alert%20%2F%208/test', body: {}, relay: 'actor',
  },
  {
    name: 'deleteAlert',
    invoke: (service) => service.deleteAlert(ACTOR, 'alert / 9'),
    method: 'delete', pathname: '/api/v1/discord/me/alerts/alert%20%2F%209', relay: 'actor',
  },
  {
    name: 'getMyBlockadeReliefRequests',
    invoke: (service) => service.getMyBlockadeReliefRequests(ACTOR),
    method: 'get', pathname: '/api/v1/discord/me/blockade-relief', relay: 'actor',
  },
  {
    name: 'getAvailableBlockadeReliefRequests',
    invoke: (service) => service.getAvailableBlockadeReliefRequests(ACTOR),
    method: 'get', pathname: '/api/v1/discord/me/blockade-relief/available', relay: 'actor',
  },
  {
    name: 'createBlockadeReliefRequest',
    invoke: (service) => service.createBlockadeReliefRequest(ACTOR, { war_id: 44, deadline_hours: 6 }),
    method: 'post', pathname: '/api/v1/discord/me/blockade-relief',
    body: { war_id: 44, deadline_hours: 6 }, relay: 'actor',
  },
  {
    name: 'claimBlockadeReliefRequest',
    invoke: (service) => service.claimBlockadeReliefRequest(ACTOR, 'request / 10'),
    method: 'post', pathname: '/api/v1/discord/me/blockade-relief/request%20%2F%2010/claim', body: {}, relay: 'actor',
  },
  {
    name: 'cancelBlockadeReliefRequest',
    invoke: (service) => service.cancelBlockadeReliefRequest(ACTOR, 'request / 11'),
    method: 'post', pathname: '/api/v1/discord/me/blockade-relief/request%20%2F%2011/cancel', body: {}, relay: 'actor',
  },
  {
    name: 'fetchDiscordQueue',
    invoke: (service) => service.fetchDiscordQueue(7),
    method: 'get', pathname: '/api/v1/discord/queue', query: { limit: '7' },
  },
  {
    name: 'claimDiscordQueue',
    invoke: (service) => service.claimDiscordQueue('worker-1', 'request-1', 'alerts'),
    method: 'post', pathname: '/api/v1/discord/queue/claim',
    body: { worker_id: 'worker-1', request_id: 'request-1', lanes: ['alerts'], guild_id: GUILD_ID },
  },
  {
    name: 'renewDiscordQueueLease',
    invoke: (service) => service.renewDiscordQueueLease('queue / 1', 'lease-1'),
    method: 'post', pathname: '/api/v1/discord/queue/queue%20%2F%201/lease', body: { lease_token: 'lease-1' },
  },
  {
    name: 'checkpointDiscordQueue',
    invoke: (service) => service.checkpointDiscordQueue('queue / 2', 'lease-2', { discord_channel_id: '123' }),
    method: 'patch', pathname: '/api/v1/discord/queue/queue%20%2F%202/checkpoint',
    body: { lease_token: 'lease-2', result: { discord_channel_id: '123' } },
  },
  {
    name: 'updateDiscordQueueStatus',
    invoke: (service) => service.updateDiscordQueueStatus('queue / 3', 'complete', 'lease-3', { result: { sent: true } }),
    method: 'post', pathname: '/api/v1/discord/queue/queue%20%2F%203/status',
    body: { status: 'complete', lease_token: 'lease-3', result: { sent: true } },
  },
  {
    name: 'getAlertRendererManifest',
    invoke: (service) => service.getAlertRendererManifest(),
    method: 'get', pathname: '/api/v1/discord/alerts/manifest', relay: 'service',
  },
  {
    name: 'getNexusStatus',
    invoke: (service) => service.getNexusStatus(ACTOR),
    method: 'get', pathname: '/api/v1/discord/status', relay: 'actor',
  },
  {
    name: 'previewApplication',
    invoke: (service) => service.previewApplication(ACTOR, {
      nation_id: 9001,
      discord_username: 'Applicant',
    }),
    method: 'post', pathname: '/api/v1/discord/applications/preview',
    body: { nation_id: 9001, discord_username: 'Applicant' }, relay: 'actor',
  },
  {
    name: 'confirmApplication',
    invoke: (service) => service.confirmApplication(ACTOR, { intent_id: 'application-intent' }),
    method: 'post', pathname: '/api/v1/discord/applications/confirm',
    body: { intent_id: 'application-intent' }, relay: 'actor',
  },
  {
    name: 'previewMemberProfileSync',
    invoke: (service) => service.previewMemberProfileSync(ACTOR, {
      observed: { nickname: 'Old Nickname', role_ids: ['423456789012345678'] },
    }),
    method: 'post', pathname: '/api/v1/discord/me/profile-sync/preview',
    body: { observed: { nickname: 'Old Nickname', role_ids: ['423456789012345678'] } }, relay: 'actor',
  },
  {
    name: 'confirmMemberProfileSync',
    invoke: (service) => service.confirmMemberProfileSync(ACTOR, { intent_id: 'profile-sync-intent' }),
    method: 'post', pathname: '/api/v1/discord/me/profile-sync/confirm',
    body: { intent_id: 'profile-sync-intent' }, relay: 'actor',
  },
  {
    name: 'previewAccountLink',
    invoke: (service) => service.previewAccountLink(ACTOR, {
      token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      discord_username: 'Applicant',
    }),
    method: 'post', pathname: '/api/v1/discord/link/preview',
    body: {
      token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      discord_username: 'Applicant',
    },
    relay: 'actor',
  },
  {
    name: 'confirmAccountLink',
    invoke: (service) => service.confirmAccountLink(ACTOR, { intent_id: 'link-intent' }),
    method: 'post', pathname: '/api/v1/discord/link/confirm',
    body: { intent_id: 'link-intent' }, relay: 'actor',
  },
  {
    name: 'getWarCounter',
    invoke: (service) => service.getWarCounter('counter / 77'),
    method: 'get', pathname: '/api/v1/discord/war-counters/counter%20%2F%2077',
  },
  {
    name: 'getMilcomObjective',
    invoke: (service) => service.getMilcomObjective('objective / 123'),
    method: 'get', pathname: '/api/v1/discord/milcom/objectives/objective%20%2F%20123',
  },
  {
    name: 'createApplication',
    invoke: (service) => service.createApplication({ nation_id: 1 }),
    method: 'post', pathname: '/api/v1/discord/applications', body: { nation_id: 1 }, explicitBearer: true,
  },
  {
    name: 'attachApplicationChannel',
    invoke: (service) => service.attachApplicationChannel({ application_id: 1, discord_channel_id: '123' }),
    method: 'post', pathname: '/api/v1/discord/applications/attach-channel',
    body: { application_id: 1, discord_channel_id: '123' }, explicitBearer: true,
  },
  {
    name: 'attachWarCounterChannel',
    invoke: (service) => service.attachWarCounterChannel({ war_counter_id: 1, discord_channel_id: '123' }),
    method: 'post', pathname: '/api/v1/discord/war-counters/attach-channel',
    body: { war_counter_id: 1, discord_channel_id: '123' }, relay: 'service', explicitBearer: true,
  },
  {
    name: 'attachMilcomObjectiveRoom',
    invoke: (service) => service.attachMilcomObjectiveRoom({ objective_id: 1, dispatch_id: 2, discord_channel_id: '123' }),
    method: 'post', pathname: '/api/v1/discord/milcom/objectives/attach-room',
    body: { objective_id: 1, dispatch_id: 2, discord_channel_id: '123' }, relay: 'service', explicitBearer: true,
  },
  {
    name: 'archiveWarCounter',
    invoke: (service) => service.archiveWarCounter({ war_counter_id: 1 }, ACTOR),
    method: 'post', pathname: '/api/v1/discord/war-counters/archive', body: { war_counter_id: 1 },
    relay: 'actor', explicitBearer: true,
  },
  {
    name: 'sweepPrimaryOffshore',
    invoke: (service) => service.sweepPrimaryOffshore({ moderator_discord_id: ACTOR.discordUserId }, ACTOR),
    method: 'post', pathname: '/api/v1/discord/offshores/sweep-primary',
    body: { moderator_discord_id: ACTOR.discordUserId }, relay: 'actor', explicitBearer: true,
  },
  {
    name: 'logApplicationMessage',
    invoke: (service) => service.logApplicationMessage({ discord_message_id: '789' }),
    method: 'post', pathname: '/api/v1/discord/applications/messages',
    body: { discord_message_id: '789' }, explicitBearer: true,
  },
  {
    name: 'sendIntelReport',
    invoke: (service) => service.sendIntelReport({ report: 'intel' }),
    method: 'post', pathname: '/api/v1/discord/intel', body: { report: 'intel' }, explicitBearer: true,
  },
  {
    name: 'approveApplication',
    invoke: (service) => service.approveApplication({ applicant_discord_id: '456' }, ACTOR),
    method: 'post', pathname: '/api/v1/discord/applications/approve',
    body: { applicant_discord_id: '456' }, relay: 'actor', explicitBearer: true,
  },
  {
    name: 'denyApplication',
    invoke: (service) => service.denyApplication({ applicant_discord_id: '456' }, ACTOR),
    method: 'post', pathname: '/api/v1/discord/applications/deny',
    body: { applicant_discord_id: '456' }, relay: 'actor', explicitBearer: true,
  },
  {
    name: 'verifyUser',
    invoke: (service) => service.verifyUser({ token: 'verify-token', discord_id: ACTOR.discordUserId }),
    method: 'post', pathname: '/api/v1/discord/verify',
    body: { token: 'verify-token', discord_id: ACTOR.discordUserId }, explicitBearer: true, directPost: true,
  },
];

test('ApiService builds queue fetch and status update requests', async () => {
  const service = createApiService();
  const requests = [];
  service.http.request = async (options) => {
    requests.push(options);
    return { data: { ok: true } };
  };

  assert.deepEqual(await service.fetchDiscordQueue(7), { ok: true });
  assert.deepEqual(await service.updateDiscordQueueStatus('queue-1', 'complete'), { ok: true });

  assert.equal(requests[0].method, 'get');
  assert.equal(requests[0].url, 'https://nexus.example/api/v1/discord/queue?limit=7');
  assert.equal(requests[1].method, 'post');
  assert.equal(requests[1].url, 'https://nexus.example/api/v1/discord/queue/queue-1/status');
  assert.deepEqual(requests[1].data, { status: 'complete' });
});

test('ApiService builds leased queue and war-counter requests', async () => {
  const service = createApiService();
  const requests = [];
  service.http.request = async (options) => {
    requests.push(options);
    return { data: { ok: true } };
  };

  await service.claimDiscordQueue('worker-1', 'request-1', 'alerts');
  await service.renewDiscordQueueLease('queue-1', 'lease-1');
  await service.checkpointDiscordQueue('queue-1', 'lease-1', { discord_channel_id: '123' });
  await service.updateDiscordQueueStatus('queue-1', 'failed', 'lease-1', {
    error_code: 'send_failed',
    error_message: 'Discord rejected the message',
    result: { delivery: 'failed', retryable: true },
  });
  await service.getWarCounter(77);

  assert.deepEqual(requests.map(({ method }) => method), ['post', 'post', 'patch', 'post', 'get']);
  assert.deepEqual(requests[0].data, {
    worker_id: 'worker-1',
    request_id: 'request-1',
    lanes: ['alerts'],
    guild_id: GUILD_ID,
  });
  assert.deepEqual(requests[2].data, {
    lease_token: 'lease-1',
    result: { discord_channel_id: '123' },
  });
  assert.deepEqual(requests[3].data, {
    status: 'failed',
    lease_token: 'lease-1',
    error_code: 'send_failed',
    error_message: 'Discord rejected the message',
    result: { delivery: 'failed', retryable: true },
  });
  assert.equal(requests[4].url, 'https://nexus.example/api/v1/discord/war-counters/77');
});

test('ApiService signs and retries the idempotent Milcom objective room callback', async () => {
  const service = createApiService({
    maxRetries: 2,
    random: () => 0,
    sleep: async () => {},
  });
  const requests = [];
  let callbackAttempts = 0;
  service.http.request = async (options) => {
    requests.push(options);
    if (options.method === 'post') {
      callbackAttempts += 1;
      if (callbackAttempts === 1) {
        const error = new Error('Temporary Nexus failure');
        error.response = { status: 503 };
        throw error;
      }
    }
    return { data: { ok: true } };
  };

  assert.deepEqual(await service.getMilcomObjective(123), { ok: true });
  assert.deepEqual(await service.attachMilcomObjectiveRoom({
    objective_id: 123,
    dispatch_id: 456,
    discord_channel_id: '323456789012345678',
  }), { ok: true });

  assert.equal(requests[0].method, 'get');
  assert.equal(requests[0].url, 'https://nexus.example/api/v1/discord/milcom/objectives/123');
  assert.equal(callbackAttempts, 2);
  assert.equal(requests[1].url, 'https://nexus.example/api/v1/discord/milcom/objectives/attach-room');
  assert.deepEqual(requests[1].data, {
    objective_id: 123,
    dispatch_id: 456,
    discord_channel_id: '323456789012345678',
  });
  assert.equal(requests[1].headers.Authorization, 'Bearer secret-key');
  assert.equal(typeof requests[1].headers['X-Nexus-Discord-Relay-Signature'], 'string');
  const relayPayload = JSON.parse(Buffer.from(
    requests[1].headers['X-Nexus-Discord-Relay-Payload'],
    'base64url',
  ).toString('utf8'));
  assert.deepEqual(relayPayload, {
    relay_version: 1,
    proof_type: 'service',
    nonce: '11111111-2222-4333-8444-555555555555',
    guild_id: GUILD_ID,
    action: 'milcom.objectives.attach-room',
  });
});

test('ApiService route matrix covers every public endpoint method exactly', async (t) => {
  const coveredMethods = endpointCases.map(({ name }) => name);
  const publicEndpointMethods = Object.getOwnPropertyNames(ApiService.prototype)
    .filter((name) => !['constructor', 'request'].includes(name))
    .sort();

  assert.equal(new Set(coveredMethods).size, coveredMethods.length);
  assert.deepEqual([...coveredMethods].sort(), publicEndpointMethods);
  assert.equal(Object.hasOwn(ApiService.prototype, 'requestDiscord'), false);

  for (const endpointCase of endpointCases) {
    await t.test(endpointCase.name, async () => {
      const service = createApiService();
      const requests = [];
      service.http.request = async (options) => {
        requests.push(options);
        return { data: { data: { ok: true }, meta: { contract_version: 1 } } };
      };
      service.http.post = async (url, data, options = {}) => {
        requests.push({ method: 'post', url, data, headers: options.headers });
        return { status: 200, data: { ok: true } };
      };

      await endpointCase.invoke(service);

      assert.equal(requests.length, 1);
      const [request] = requests;
      const url = new URL(request.url);
      assert.equal(request.method, endpointCase.method);
      assert.equal(url.pathname, endpointCase.pathname);
      assert.deepEqual(Object.fromEntries(url.searchParams), endpointCase.query ?? {});
      assert.deepEqual(request.data, endpointCase.body);
      assert.equal(service.http.defaults.headers.Authorization, 'Bearer secret-key');
      assert.equal(service.http.defaults.headers['X-API-Key'], 'secret-key');

      const headers = request.headers ?? {};
      if (endpointCase.explicitBearer) {
        assert.equal(headers.Authorization, 'Bearer secret-key');
      }
      if (endpointCase.relay === 'actor') {
        assert.equal(headers['X-Discord-User-ID'], ACTOR.discordUserId);
        assert.equal(headers['X-Discord-Guild-ID'], ACTOR.discordGuildId);
        assert.equal(headers['X-Discord-Interaction-ID'], ACTOR.discordInteractionId);
        assert.equal(typeof headers['X-Nexus-Discord-Relay-Signature'], 'string');
      } else if (endpointCase.relay === 'service') {
        assert.equal(typeof headers['X-Nexus-Discord-Relay-Signature'], 'string');
        const relayPayload = JSON.parse(Buffer.from(
          headers['X-Nexus-Discord-Relay-Payload'],
          'base64url',
        ).toString('utf8'));
        assert.equal(relayPayload.proof_type, 'service');
      } else {
        assert.equal(headers['X-Nexus-Discord-Relay-Signature'], undefined);
      }
    });
  }
});

test('ApiService actor transport accepts a valid contract-1 envelope', async () => {
  const service = createApiService();
  service.http.request = async () => ({
    data: { data: { accounts: [{ id: 1 }] }, meta: { contract_version: 1 } },
  });

  assert.deepEqual(await service.getMyAccounts(ACTOR), { accounts: [{ id: 1 }] });
});

test('ApiService preserves Nexus metadata for the Operations projection', async () => {
  const service = createApiService();
  service.http.request = async () => ({
    data: {
      data: [{ work_key: 'loans:42' }],
      meta: {
        contract_version: 1,
        provider: 'nexus_operations',
        complete: false,
        unavailable_sources: [{ type: 'applications', label: 'Applications' }],
      },
    },
  });

  assert.deepEqual(await service.getStaffWorkItems(ACTOR), {
    data: [{ work_key: 'loans:42' }],
    meta: {
      contract_version: 1,
      provider: 'nexus_operations',
      complete: false,
      unavailable_sources: [{ type: 'applications', label: 'Applications' }],
    },
  });
});

test('ApiService actor transport rejects missing data and unsupported contract versions', async () => {
  for (const envelope of [
    { meta: { contract_version: 1 } },
    { data: {}, meta: { contract_version: 2 } },
  ]) {
    const service = createApiService();
    service.http.request = async () => ({ data: envelope });

    await assert.rejects(
      () => service.getMyAccounts(ACTOR),
      (error) => error instanceof ApiContractError
        && error.code === 'INVALID_RESPONSE'
        && error.message === 'Nexus returned an unsupported Discord response contract.',
    );
  }
});

test('ApiService actor transport rejects malformed error envelopes', async () => {
  const service = createApiService();
  service.http.request = async () => ({
    data: { error: { message: 'Missing a code.' }, meta: { contract_version: 1 } },
  });

  await assert.rejects(
    () => service.getMyAccounts(ACTOR),
    (error) => error instanceof ApiContractError
      && error.code === 'INVALID_RESPONSE'
      && error.message === 'Nexus returned a malformed Discord error response.',
  );
});

test('ApiService actor transport preserves structured provider error details', async () => {
  const service = createApiService();
  service.http.request = async () => {
    const error = new Error('Provider rejected the request');
    error.response = {
      status: 422,
      data: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The nation_id field is required.',
          details: { nation_id: ['The nation_id field is required.'] },
        },
      },
    };
    throw error;
  };

  await assert.rejects(
    () => service.getWarCounterRecommendation(ACTOR, null),
    (error) => error instanceof ApiContractError
      && error.code === 'VALIDATION_ERROR'
      && error.status === 422
      && error.message === 'The nation_id field is required.'
      && error.details.nation_id[0] === 'The nation_id field is required.',
  );
});

test('ApiService does not retry non-retryable API responses', async () => {
  const service = createApiService({ maxRetries: 3 });
  let attempts = 0;
  service.http.request = async () => {
    attempts += 1;
    const error = new Error('Bad request');
    error.response = { status: 400 };
    throw error;
  };

  await assert.rejects(() => service.request({ method: 'get', url: '/bad' }, RetryMode.SAFE), /Bad request/);
  assert.equal(attempts, 1);
});

test('ApiService retries only safe/idempotent transient failures and honors Retry-After', async () => {
  const sleeps = [];
  const service = createApiService({
    maxRetries: 3,
    random: () => 0,
    sleep: async (duration) => sleeps.push(duration),
  });
  let attempts = 0;
  service.http.request = async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('Rate limited');
      error.response = { status: 429, headers: { 'retry-after': '0.25' } };
      throw error;
    }
    return { data: { ok: true } };
  };

  assert.deepEqual(await service.request({ method: 'post', url: '/safe' }, RetryMode.IDEMPOTENT), { ok: true });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [250, 250]);

  attempts = 0;
  service.http.request = async () => {
    attempts += 1;
    const error = new Error('Response lost');
    error.code = 'ECONNRESET';
    throw error;
  };
  await assert.rejects(() => service.request({ method: 'post', url: '/unsafe' }, RetryMode.NEVER));
  assert.equal(attempts, 1);
});

test('ApiService retries network, 408, and 5xx failures with bounded exponential jitter', async () => {
  for (const failure of [
    { code: 'ECONNRESET' },
    { response: { status: 408, headers: {} } },
    { response: { status: 503, headers: {} } },
  ]) {
    const sleeps = [];
    const service = createApiService({
      maxRetries: 2,
      random: () => 0.5,
      sleep: async (duration) => sleeps.push(duration),
    });
    let attempts = 0;
    service.http.request = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('transient'), failure);
      return { data: { ok: true } };
    };

    assert.deepEqual(await service.request({ method: 'get', url: '/retry' }, RetryMode.SAFE), { ok: true });
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [562]);
  }
});

test('ApiService validates retry modes and supports HTTP-date Retry-After headers', async () => {
  const sleeps = [];
  const service = createApiService({
    maxRetries: 2,
    sleep: async (duration) => sleeps.push(duration),
  });
  await assert.rejects(
    () => service.request({ method: 'get', url: '/bad-mode' }, 'sometimes'),
    /Unknown API retry mode/,
  );

  let attempts = 0;
  service.http.request = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('busy');
      error.response = {
        status: 503,
        headers: { get: () => new Date(Date.now() + 60_000).toUTCString() },
      };
      throw error;
    }
    return { data: { ok: true } };
  };
  await service.request({ method: 'get', url: '/date-retry' }, RetryMode.SAFE);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0] > 50_000 && sleeps[0] <= 60_000, true);
});

test('ApiService verifyUser normalizes API errors and redacts token details', async () => {
  const service = createApiService();
  service.http.post = async () => {
    const error = new Error('Conflict');
    error.response = {
      status: 409,
      data: {
        message: 'Already linked.',
        token: 'secret-user-token',
      },
    };
    throw error;
  };

  const result = await service.verifyUser({
    token: 'secret-user-token',
    discord_id: 'user-1',
    discord_username: 'Tester',
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'CONFLICT');
  assert.equal(result.message, 'Already linked.');
  assert.equal(result.details.token, '[REDACTED]');
  assert.equal(result.error.details.token, '[REDACTED]');
});

test('ApiService verifyUser returns network and setup failures without throwing', async () => {
  const networkService = createApiService();
  networkService.http.post = async () => {
    const error = new Error('No response');
    error.request = {};
    throw error;
  };

  const networkResult = await networkService.verifyUser({ token: 'code' });
  assert.equal(networkResult.success, false);
  assert.equal(networkResult.code, 'NETWORK_ERROR');

  const setupService = createApiService();
  setupService.http.post = async () => {
    throw new Error('Invalid config');
  };

  const setupResult = await setupService.verifyUser({ token: 'code' });
  assert.equal(setupResult.success, false);
  assert.equal(setupResult.code, 'UNEXPECTED_ERROR');
});
