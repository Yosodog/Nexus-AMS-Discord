import axios from 'axios';
import {
  createPublicHttpsAgent,
  validateNexusEndpoint,
} from './connection/EndpointGuard.js';
import {
  isOfficialSharedMode,
} from './connection/ConnectionContext.js';
import {
  normalizePathQuery,
} from './connection/relayContracts.js';
import { V2_SERVICE_PROOF_ACTIONS } from './connection/Capabilities.js';

export const RetryMode = Object.freeze({
  SAFE: 'safe',
  IDEMPOTENT: 'idempotent',
  NEVER: 'never',
});

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_REQUEST_BYTES = 262_144;

const selectQueryParams = (params, supportedKeys) => {
  const values = params ?? {};
  return Object.fromEntries(
    supportedKeys
      .filter((key) => Object.hasOwn(values, key))
      .map((key) => [key, values[key]]),
  );
};

export class ApiContractError extends Error {
  constructor(message, { code = 'INVALID_RESPONSE', status = null, details = null } = {}) {
    super(message);
    this.name = 'ApiContractError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * REST API client wrapper for Nexus AMS backend.
 * Only scaffolds shared concerns (base configuration, retries, headers) for future expansion.
 */
export class ApiService {
  /**
   * @param {object} options configuration options
   * @param {string} options.baseUrl base URL for the Nexus API
   * @param {string} options.apiKey shared secret for authentication
   * @param {import('./Logger.js').Logger} options.logger structured logger instance
   * @param {import('./DiscordRelaySigner.js').DiscordRelaySigner} options.relaySigner asymmetric relay proof signer
   * @param {number} [options.timeoutMs=10000] request timeout in milliseconds
   * @param {number} [options.maxRetries=3] number of retry attempts for transient failures
   */
  constructor({
    baseUrl,
    apiKey,
    logger,
    relaySigner = null,
    connectionContext = null,
    timeoutMs = 10000,
    maxRetries = 3,
    random = Math.random,
    sleep = null,
    dnsLookup = null,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.logger = logger;
    this.relaySigner = relaySigner;
    this.connectionContext = connectionContext;
    const sharedConnection = isOfficialSharedMode(connectionContext?.mode);
    if (sharedConnection) {
      this.baseUrl = validateNexusEndpoint(baseUrl, { shared: true });
    }
    const boundedTimeoutMs = Math.min(
      Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 100),
      MAX_TIMEOUT_MS,
    );
    const boundedResponseBytes = Math.min(
      Math.max(Number(maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES, 1),
      16 * 1024 * 1024,
    );
    const boundedRequestBytes = Math.min(
      Math.max(Number(maxRequestBytes) || DEFAULT_MAX_REQUEST_BYTES, 1),
      4 * 1024 * 1024,
    );
    this.maxRetries = maxRetries;
    this.random = random;
    this.sleep = sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));

    const axiosOptions = {
      baseURL: this.baseUrl,
      timeout: boundedTimeoutMs,
      maxRedirects: 0,
      maxContentLength: boundedResponseBytes,
      maxBodyLength: boundedRequestBytes,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Nexus-AMS-DiscordBot/0.1',
        'X-API-Key': this.apiKey,
        // Some Nexus endpoints expect bearer tokens; keep both headers for flexibility.
        Authorization: `Bearer ${this.apiKey}`,
      },
    };
    if (sharedConnection) {
      Object.assign(axiosOptions, {
        proxy: false,
        httpsAgent: createPublicHttpsAgent(this.baseUrl, { lookup: dnsLookup ?? undefined }),
      });
    }

    this.http = axios.create(axiosOptions);
  }

  /**
   * Generic request wrapper with basic retry support for transient network/server issues.
   * @param {object} options axios-compatible request options
   * @returns {Promise<any>} parsed JSON response body
   */
  async request(options, retryMode = RetryMode.NEVER) {
    if (!Object.values(RetryMode).includes(retryMode)) {
      throw new TypeError(`Unknown API retry mode: ${retryMode}`);
    }

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const requestOptions = this.#isV2Relay() && options?.url
          ? { ...options, url: this.#canonicalRequestUrl(options.url) }
          : options;
        const response = await this.http.request(requestOptions);
        return response.data;
      } catch (error) {
        const isLastAttempt = attempt === this.maxRetries;
        const retryable = retryMode !== RetryMode.NEVER && this.#isRetryableError(error);
        this.logger.warn(
          `API request failed (attempt ${attempt}/${this.maxRetries})`,
          {
            url: options?.url,
            method: options?.method,
            status: error?.response?.status ?? null,
            retryMode,
            retryable,
            errorCode: error?.code ?? null,
          },
        );

        if (isLastAttempt || !retryable) {
          this.logger.error('API request failed permanently', {
            url: options?.url,
            method: options?.method,
            status: error?.response?.status ?? null,
            retryMode,
            errorCode: error?.code ?? null,
          });
          throw error;
        }

        await this.#delay(this.#retryDelay(error, attempt));
      }
    }

    // This should never be hit, but return undefined to satisfy explicit control flow.
    return undefined;
  }

  /**
   * Call a versioned Discord actor endpoint and unwrap its strict response envelope.
   * Nexus owns authorization and all financial/business calculations; the bot only
   * forwards strings selected or entered by the Discord actor.
   */
  async #requestDiscord(path, {
    method = 'get',
    data,
    params,
    actor,
    retryMode = RetryMode.NEVER,
    includeMeta = false,
  } = {}) {
    const normalizedMethod = `${method}`.toLowerCase();
    const isWrite = !['get', 'head', 'options'].includes(normalizedMethod);
    const endpointUrl = new URL(`/api/v1/discord/${`${path}`.replace(/^\/+/, '')}`, this.baseUrl);

    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && `${value}` !== '') {
        endpointUrl.searchParams.set(key, `${value}`);
      }
    }
    if (this.#isV2Relay()) {
      // URLSearchParams uses '+', while relay-v2 canonical targets require
      // spaces to be represented as %20 and reserve '+' for a literal plus.
      endpointUrl.search = endpointUrl.search.replaceAll('+', '%20');
    }

    const headers = this.#discordActorHeaders(actor, isWrite, {
      method: normalizedMethod,
      url: endpointUrl.toString(),
      data,
      action: actor?.discordAction ?? actor?.action ?? actor?.discordCommand ?? actor?.command,
    });

    let envelope;
    try {
      envelope = await this.request({
        method: normalizedMethod,
        url: endpointUrl.toString(),
        data,
        headers,
      }, retryMode);
    } catch (error) {
      const apiError = error?.response?.data?.error;
      if (apiError && typeof apiError.code === 'string' && apiError.code.trim() !== '') {
        throw new ApiContractError(
          typeof apiError.message === 'string' && apiError.message.trim() !== ''
            ? apiError.message
            : 'Nexus rejected the request.',
          {
            code: apiError.code,
            status: error?.response?.status ?? null,
            details: apiError.details ?? null,
          },
        );
      }
      throw error;
    }

    const responseData = this.#unwrapDiscordEnvelope(envelope);
    return includeMeta ? { data: responseData, meta: envelope.meta } : responseData;
  }

  getContext(actor) {
    return this.#requestDiscord('context', { actor, retryMode: RetryMode.SAFE });
  }

  getMySummary(actor) {
    return this.#requestDiscord('me/summary', { actor, retryMode: RetryMode.SAFE });
  }

  getMyAccounts(actor, params = {}) {
    return this.#requestDiscord('me/accounts', {
      actor,
      params: selectQueryParams(params, ['account', 'query', 'limit']),
      retryMode: RetryMode.SAFE,
    });
  }

  createDepositRequest(actor, accountToken, payload) {
    return this.#requestDiscord(`me/accounts/${encodeURIComponent(accountToken)}/deposit-requests`, {
      method: 'post', actor, data: payload,
    });
  }

  createWithdrawalDraft(actor, payload) {
    return this.#requestDiscord('me/withdrawals/drafts', { method: 'post', actor, data: payload });
  }

  getWithdrawalIntent(actor, intentToken) {
    return this.#requestDiscord(`me/withdrawals/${encodeURIComponent(intentToken)}`, {
      actor, retryMode: RetryMode.SAFE,
    });
  }

  confirmWithdrawal(actor, intentToken) {
    return this.#requestDiscord(`me/withdrawals/${encodeURIComponent(intentToken)}/confirm`, {
      method: 'post', actor, data: {},
    });
  }

  cancelWithdrawal(actor, intentToken) {
    return this.#requestDiscord(`me/withdrawals/${encodeURIComponent(intentToken)}/cancel`, {
      method: 'post', actor, data: {},
    });
  }

  getMyTransactions(actor, params = {}) {
    const account = params.account;
    if (!account) throw new TypeError('An opaque account token is required.');
    return this.#requestDiscord(`me/accounts/${encodeURIComponent(account)}/transactions`, {
      actor,
      params: selectQueryParams(params, ['type', 'status', 'page', 'per_page']),
      retryMode: RetryMode.SAFE,
    });
  }

  getMyRequests(actor, params = {}) {
    return this.#requestDiscord('me/requests', {
      actor,
      params: selectQueryParams(params, ['type', 'status']),
      retryMode: RetryMode.SAFE,
    });
  }

  getGrantPrograms(actor, params = {}) {
    return this.#requestDiscord('me/grants', {
      actor,
      params: selectQueryParams(params, ['eligible_only', 'query', 'limit']),
      retryMode: RetryMode.SAFE,
    });
  }

  previewGrantApplication(actor, payload) {
    return this.#requestDiscord('me/grant-applications/preview', { method: 'post', actor, data: payload });
  }

  confirmGrantApplication(actor, payload) {
    return this.#requestDiscord('me/grant-applications/confirm', { method: 'post', actor, data: payload });
  }

  previewCityGrantRequest(actor, payload) {
    return this.#requestDiscord('me/city-grant-requests/preview', { method: 'post', actor, data: payload });
  }

  confirmCityGrantRequest(actor, payload) {
    return this.#requestDiscord('me/city-grant-requests/confirm', { method: 'post', actor, data: payload });
  }

  getMyGrantRequests(actor, params = {}) {
    return this.#requestDiscord('me/requests', {
      actor,
      params: { type: 'grant', ...selectQueryParams(params, ['status']) },
      retryMode: RetryMode.SAFE,
    });
  }

  previewLoanApplication(actor, payload) {
    return this.#requestDiscord('me/loan-applications/preview', { method: 'post', actor, data: payload });
  }

  confirmLoanApplication(actor, payload) {
    return this.#requestDiscord('me/loan-applications/confirm', { method: 'post', actor, data: payload });
  }

  getMyLoans(actor) {
    return this.#requestDiscord('me/loans', { actor, retryMode: RetryMode.SAFE });
  }

  previewLoanPayment(actor, payload) {
    return this.#requestDiscord('me/loan-payments/preview', { method: 'post', actor, data: payload });
  }

  confirmLoanPayment(actor, payload) {
    return this.#requestDiscord('me/loan-payments/confirm', { method: 'post', actor, data: payload });
  }

  createWarAidDraft(actor, payload) {
    return this.#requestDiscord('me/war-aid/draft', { method: 'post', actor, data: payload });
  }

  reviewWarAidDraft(actor, payload) {
    return this.#requestDiscord('me/war-aid/review', { method: 'post', actor, data: payload });
  }

  confirmWarAidRequest(actor, payload) {
    return this.#requestDiscord('me/war-aid/confirm', { method: 'post', actor, data: payload });
  }

  getMyWarAidRequests(actor) {
    return this.#requestDiscord('me/war-aid', { actor, retryMode: RetryMode.SAFE });
  }

  confirmRebuildRequest(actor, payload) {
    return this.#requestDiscord('me/rebuilding/confirm', { method: 'post', actor, data: payload });
  }

  previewRebuildRequest(actor) {
    return this.#requestDiscord('me/rebuilding/preview', { actor, retryMode: RetryMode.SAFE });
  }

  getMyRebuildRequests(actor, params = {}) {
    return this.#requestDiscord('me/requests', {
      actor,
      params: { type: 'rebuilding', ...selectQueryParams(params, ['status']) },
      retryMode: RetryMode.SAFE,
    });
  }

  getMyRaidAssignments(actor, params = {}) {
    return this.#requestDiscord('me/raids', {
      actor,
      params: selectQueryParams(params, ['nation_id', 'sort', 'limit']),
      retryMode: RetryMode.SAFE,
    });
  }

  getMyWarAssignments(actor) {
    return this.#requestDiscord('me/war-assignments', { actor, retryMode: RetryMode.SAFE });
  }

  getMyActiveWars(actor) {
    return this.#requestDiscord('me/wars', { actor, retryMode: RetryMode.SAFE });
  }

  respondToWarAssignment(actor, type, id, payload) {
    if (!['plan', 'counter'].includes(type)) throw new TypeError('War assignment type must be plan or counter.');
    return this.#requestDiscord(`me/war-assignments/${encodeURIComponent(type)}/${encodeURIComponent(id)}/response`, {
      method: 'post', actor, data: payload,
    });
  }

  getWarCounterRecommendation(actor, nationId) {
    return this.#requestDiscord('me/wars/counter', {
      actor, params: { nation_id: nationId }, retryMode: RetryMode.SAFE,
    });
  }

  getWarSimulation(actor, warToken) {
    return this.#requestDiscord(`me/wars/${encodeURIComponent(warToken)}/simulation`, {
      actor, retryMode: RetryMode.SAFE,
    });
  }

  getMilcomAssignments(actor) {
    return this.#requestDiscord('milcom/assignments', { actor, retryMode: RetryMode.SAFE });
  }

  previewMilcomAssignmentResponse(actor, assignmentId, payload) {
    return this.#requestDiscord(`milcom/assignments/${encodeURIComponent(assignmentId)}/response/preview`, {
      method: 'post', actor, data: payload,
    });
  }

  confirmMilcomAssignmentResponse(actor, assignmentId, intentId) {
    return this.#requestDiscord(`milcom/assignments/${encodeURIComponent(assignmentId)}/response/confirm`, {
      method: 'post', actor, data: { intent_id: intentId }, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  getMilcomReadiness(actor, params = {}) {
    return this.#requestDiscord('milcom/readiness', {
      actor,
      params: selectQueryParams(params, ['nation_id']),
      retryMode: RetryMode.SAFE,
    });
  }

  getMilcomWarRoom(actor, objectiveId) {
    return this.#requestDiscord(`milcom/war-rooms/${encodeURIComponent(objectiveId)}`, {
      actor, retryMode: RetryMode.SAFE,
    });
  }

  getMySpyAssignments(actor) {
    return this.#requestDiscord('me/spy-assignments', { actor, retryMode: RetryMode.SAFE });
  }

  getMyAuditFindings(actor) {
    return this.#requestDiscord('me/audits', { actor, retryMode: RetryMode.SAFE });
  }

  acknowledgeAuditFinding(actor, findingId, payload = {}) {
    return this.#requestDiscord(`me/audits/${encodeURIComponent(findingId)}/acknowledge`, {
      method: 'post', actor, data: payload,
    });
  }

  snoozeAuditFinding(actor, findingId, payload) {
    return this.#requestDiscord(`me/audits/${encodeURIComponent(findingId)}/snooze`, {
      method: 'post', actor, data: payload,
    });
  }

  getStaffApplications(actor, params = {}) {
    return this.#requestDiscord('staff/applications', {
      actor,
      params: selectQueryParams(params, [
        'status', 'filter', 'query', 'applicant_discord_id', 'discord_channel_id', 'limit',
      ]),
      retryMode: RetryMode.SAFE,
    });
  }

  getMyApplications(actor) {
    return this.#requestDiscord('me/applications', { actor, retryMode: RetryMode.SAFE });
  }

  getStaffApplicationReview(actor, params = {}) {
    if (!params.application) throw new TypeError('An opaque application token is required.');
    return this.#requestDiscord(`staff/applications/${encodeURIComponent(params.application)}`, {
      actor, retryMode: RetryMode.SAFE,
    });
  }

  decideStaffApplication(actor, applicationToken, decision, payload = {}) {
    if (!['approve', 'deny'].includes(decision)) {
      throw new TypeError('Application decision must be approve or deny.');
    }
    return this.#requestDiscord(`staff/applications/${encodeURIComponent(applicationToken)}/${encodeURIComponent(decision)}`, {
      method: 'post',
      actor,
      data: payload,
    });
  }

  getStaffRequests(actor, params = {}) {
    return this.#requestDiscord('staff/requests', {
      actor,
      params: selectQueryParams(params, ['type', 'status', 'limit']),
      retryMode: RetryMode.SAFE,
    });
  }

  getStaffWorkItems(actor, params = {}) {
    return this.#requestDiscord('staff/work-items', {
      actor,
      params: selectQueryParams(params, [
        'q', 'type', 'urgency', 'owner', 'domain_owner', 'team', 'priority', 'severity',
        'attention_reason', 'assignee', 'requester', 'next_actor', 'overdue', 'blocked',
        'watched', 'due_from', 'due_to', 'changed_from', 'changed_to', 'freshness',
        'sort', 'direction', 'page', 'per_page',
      ]),
      retryMode: RetryMode.SAFE,
      includeMeta: true,
    });
  }

  getStaffWorkItem(actor, type, id) {
    if (`${type ?? ''}`.trim() === '' || `${id ?? ''}`.trim() === '') {
      throw new TypeError('A work-item source and identifier are required.');
    }
    return this.#requestDiscord(
      `staff/work-items/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
      { actor, retryMode: RetryMode.SAFE },
    );
  }

  /** Return the minimal Nexus identity projection for a Discord user. */
  getDirectoryDiscordUser(actor, discordUserId) {
    if (!/^\d{17,20}$/.test(`${discordUserId ?? ''}`)) {
      throw new TypeError('A valid Discord user ID is required.');
    }
    return this.#requestDiscord(`directory/discord-users/${encodeURIComponent(discordUserId)}`, {
      actor,
      retryMode: RetryMode.SAFE,
    });
  }

  /** Search Nexus's cached nation directory. */
  searchDirectoryNations(actor, query) {
    return this.#requestDiscord('directory/nations', {
      actor,
      params: selectQueryParams({ query }, ['query']),
      retryMode: RetryMode.SAFE,
    });
  }

  /** Return one allowlisted nation projection. */
  getDirectoryNation(actor, nationId) {
    if (!/^\d{1,10}$/.test(`${nationId ?? ''}`)) throw new TypeError('A valid nation ID is required.');
    return this.#requestDiscord(`directory/nations/${encodeURIComponent(nationId)}`, {
      actor,
      retryMode: RetryMode.SAFE,
    });
  }

  /** Return the actor's current Nexus build recommendation. */
  getMyBuildRecommendation(actor) {
    return this.#requestDiscord('me/build-recommendation', {
      actor,
      retryMode: RetryMode.SAFE,
    });
  }

  /** Search Nexus's cached alliance directory. */
  searchDirectoryAlliances(actor, query) {
    return this.#requestDiscord('directory/alliances', {
      actor,
      params: selectQueryParams({ query }, ['query']),
      retryMode: RetryMode.SAFE,
    });
  }

  /** Return one allowlisted alliance projection. */
  getDirectoryAlliance(actor, allianceId) {
    if (!/^\d{1,10}$/.test(`${allianceId ?? ''}`)) throw new TypeError('A valid alliance ID is required.');
    return this.#requestDiscord(`directory/alliances/${encodeURIComponent(allianceId)}`, {
      actor,
      retryMode: RetryMode.SAFE,
    });
  }

  getMyAlerts(actor) {
    return this.#requestDiscord('me/alerts', { actor, retryMode: RetryMode.SAFE });
  }

  createAlert(actor, payload) {
    return this.#requestDiscord('me/alerts', {
      method: 'post', actor, data: payload, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  getAlertSettings(actor) {
    return this.#requestDiscord('me/alerts/settings', { actor, retryMode: RetryMode.SAFE });
  }

  updateAlertSettings(actor, payload) {
    return this.#requestDiscord('me/alerts/settings', {
      method: 'put', actor, data: payload, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  getAlertActivity(actor, params = {}) {
    return this.#requestDiscord('me/alerts/activity', {
      actor,
      params: selectQueryParams(params, ['before_delivery_id', 'limit']),
      retryMode: RetryMode.SAFE,
    });
  }

  setAlertActivityRead(actor, deliveryId, read = true) {
    return this.#requestDiscord(`me/alerts/activity/${encodeURIComponent(deliveryId)}/read`, {
      method: 'patch', actor, data: { read: Boolean(read) }, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  previewAlert(actor, payload) {
    return this.#requestDiscord('me/alerts/preview', {
      method: 'post', actor, data: payload, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  testAlertDraft(actor, payload) {
    return this.#requestDiscord('me/alerts/test', {
      method: 'post', actor, data: payload, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  updateAlert(actor, alertId, payload) {
    return this.#requestDiscord(`me/alerts/${encodeURIComponent(alertId)}`, {
      method: 'put', actor, data: payload, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  getAlertDelivery(actor, deliveryId) {
    return this.#requestDiscord(`me/alerts/deliveries/${encodeURIComponent(deliveryId)}`, {
      actor, retryMode: RetryMode.SAFE,
    });
  }

  updateAlertStatus(actor, alertId, isActive) {
    return this.#requestDiscord(`me/alerts/${encodeURIComponent(alertId)}/status`, {
      method: 'patch', actor, data: { is_active: isActive }, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  testAlert(actor, alertId) {
    return this.#requestDiscord(`me/alerts/${encodeURIComponent(alertId)}/test`, {
      method: 'post', actor, data: {}, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  deleteAlert(actor, alertId) {
    return this.#requestDiscord(`me/alerts/${encodeURIComponent(alertId)}`, {
      method: 'delete', actor, retryMode: RetryMode.IDEMPOTENT,
    });
  }

  getMyBlockadeReliefRequests(actor) {
    return this.#requestDiscord('me/blockade-relief', { actor, retryMode: RetryMode.SAFE });
  }

  getAvailableBlockadeReliefRequests(actor) {
    return this.#requestDiscord('me/blockade-relief/available', { actor, retryMode: RetryMode.SAFE });
  }

  createBlockadeReliefRequest(actor, payload) {
    return this.#requestDiscord('me/blockade-relief', { method: 'post', actor, data: payload });
  }

  claimBlockadeReliefRequest(actor, requestId) {
    return this.#requestDiscord(`me/blockade-relief/${encodeURIComponent(requestId)}/claim`, {
      method: 'post', actor, data: {},
    });
  }

  cancelBlockadeReliefRequest(actor, requestId) {
    return this.#requestDiscord(`me/blockade-relief/${encodeURIComponent(requestId)}/cancel`, {
      method: 'post', actor, data: {},
    });
  }

  /**
   * Fetch pending Discord commands from the Nexus queue API.
   * @param {number} [limit=20] maximum number of items to fetch per poll
   * @returns {Promise<{ data: any[] }>} response payload from Nexus
   */
  async fetchDiscordQueue(limit = 20) {
    const endpointUrl = new URL('/api/v1/discord/queue', this.baseUrl);
    endpointUrl.searchParams.set('limit', String(limit));

    const options = {
      method: 'get',
      url: endpointUrl.toString(),
    };
    return this.request(options, RetryMode.SAFE);
  }

  /** Claim one queue item with an idempotent request identifier and optional lane. */
  async claimDiscordQueue(
    workerId,
    requestId,
    lane = null,
    guildId = this.relaySigner?.guildId ?? this.connectionContext?.guildId ?? null,
    connectionContext = this.connectionContext,
  ) {
    const endpointUrl = new URL('/api/v1/discord/queue/claim', this.baseUrl).toString();
    const data = { worker_id: workerId, request_id: requestId };
    if (typeof lane === 'string' && lane.trim() !== '') {
      data.lanes = [lane.trim()];
    }
    if (typeof guildId === 'string' && guildId.trim() !== '') {
      data.guild_id = guildId.trim();
    }
    if (this.#isV2Relay() && connectionContext) {
      data.connection_id = connectionContext.connectionId;
      data.generation = connectionContext.generation;
      data.application_id = connectionContext.applicationId;
    }

    const options = {
      method: 'post',
      url: endpointUrl,
      data,
    };
    if (this.#isV2Relay()) options.headers = this.#serviceRelayHeaders('queue.claim', options);
    const response = await this.request(options, RetryMode.IDEMPOTENT);
    if (this.#isV2Relay()) this.#assertQueueBinding(response, connectionContext);
    return response;
  }

  /** Renew an active queue lease. */
  async renewDiscordQueueLease(id, leaseToken) {
    const endpointUrl = new URL(
      `/api/v1/discord/queue/${encodeURIComponent(id)}/lease`,
      this.baseUrl,
    ).toString();

    const options = {
      method: 'post',
      url: endpointUrl,
      data: { lease_token: leaseToken },
    };
    if (this.#isV2Relay()) options.headers = this.#serviceRelayHeaders('queue.lease', options);
    return this.request(options, RetryMode.IDEMPOTENT);
  }

  /** Persist an action-specific durable checkpoint. */
  async checkpointDiscordQueue(id, leaseToken, result) {
    const endpointUrl = new URL(
      `/api/v1/discord/queue/${encodeURIComponent(id)}/checkpoint`,
      this.baseUrl,
    ).toString();

    const options = {
      method: 'patch',
      url: endpointUrl,
      data: { lease_token: leaseToken, result },
    };
    if (this.#isV2Relay()) options.headers = this.#serviceRelayHeaders('queue.checkpoint', options);
    return this.request(options, RetryMode.IDEMPOTENT);
  }

  /**
   * Report the processing outcome for a queued Discord command.
   * @param {string} id queue item identifier
   * @param {'complete' | 'failed'} status processing status to report
   * @returns {Promise<any>} response payload
   */
  async updateDiscordQueueStatus(id, status, leaseToken = null, outcomeDetails = {}) {
    const endpointUrl = new URL(
      `/api/v1/discord/queue/${encodeURIComponent(id)}/status`,
      this.baseUrl,
    );

    const data = { status };
    if (leaseToken) {
      data.lease_token = leaseToken;
    }
    if (outcomeDetails?.result !== undefined) {
      data.result = outcomeDetails.result;
    }
    if (status === 'failed' && outcomeDetails?.error_code) {
      data.error_code = outcomeDetails.error_code;
    }
    if (status === 'failed' && outcomeDetails?.error_message) {
      data.error_message = outcomeDetails.error_message;
    }

    const options = {
      method: 'post',
      url: endpointUrl.toString(),
      data,
    };
    if (this.#isV2Relay()) options.headers = this.#serviceRelayHeaders('queue.acknowledge', options);
    return this.request(options, leaseToken ? RetryMode.IDEMPOTENT : RetryMode.NEVER);
  }

  /** Fetch the Nexus renderer manifest before claiming alert-lane work. */
  async getAlertRendererManifest() {
    const endpointUrl = new URL('/api/v1/discord/alerts/manifest', this.baseUrl).toString();
    const options = {
      method: 'get',
      url: endpointUrl,
    };
    if (this.#isV2Relay()) options.headers = this.#serviceRelayHeaders('alerts.manifest', options);
    else options.headers = this.#serviceRelayHeaders('alerts.manifest');
    return this.request(options, RetryMode.SAFE);
  }

  /** Fetch provider diagnostics for /nexus status through the signed actor path. */
  getNexusStatus(actor) {
    return this.#requestDiscord('status', {
      method: 'get',
      actor: {
        ...actor,
        discordCommand: 'nexus',
        discordAction: 'nexus.status',
      },
      retryMode: RetryMode.SAFE,
    });
  }

  /** Preview a Nexus-owned application intent for an unlinked or linked Discord actor. */
  previewApplication(actor, payload) {
    return this.#requestDiscord('applications/preview', {
      method: 'post',
      data: payload,
      actor: {
        ...actor,
        discordCommand: 'apply',
        discordAction: 'apply',
      },
      retryMode: RetryMode.NEVER,
    });
  }

  /** Confirm an opaque Nexus application intent. */
  confirmApplication(actor, payload) {
    return this.#requestDiscord('applications/confirm', {
      method: 'post',
      data: payload,
      actor: {
        ...actor,
        discordCommand: 'apply',
        discordAction: 'apply',
      },
      retryMode: RetryMode.IDEMPOTENT,
    });
  }

  /** Preview the exact Nexus-owned nickname and managed-role changes for /me. */
  previewMemberProfileSync(actor, payload) {
    return this.#requestDiscord('me/profile-sync/preview', {
      method: 'post',
      data: payload,
      actor: {
        ...actor,
        discordCommand: 'me',
        discordAction: 'me',
      },
      retryMode: RetryMode.NEVER,
    });
  }

  /** Confirm an opaque Nexus member profile synchronization intent. */
  confirmMemberProfileSync(actor, payload) {
    return this.#requestDiscord('me/profile-sync/confirm', {
      method: 'post',
      data: payload,
      actor: {
        ...actor,
        discordCommand: 'me',
        discordAction: 'me',
      },
      retryMode: RetryMode.IDEMPOTENT,
    });
  }

  /** Preview linking this Discord actor to the Nexus account that issued a code. */
  previewAccountLink(actor, payload) {
    return this.#requestDiscord('link/preview', {
      method: 'post',
      data: payload,
      actor: {
        ...actor,
        discordCommand: 'verify',
        discordAction: 'verify',
      },
      retryMode: RetryMode.NEVER,
    });
  }

  /** Confirm a one-time, installation-bound Nexus account-link intent. */
  confirmAccountLink(actor, payload) {
    return this.#requestDiscord('link/confirm', {
      method: 'post',
      data: payload,
      actor: {
        ...actor,
        discordCommand: 'verify',
        discordAction: 'verify',
      },
      retryMode: RetryMode.IDEMPOTENT,
    });
  }

  /** Fetch the current persisted war-counter record. */
  async getWarCounter(id) {
    const endpointUrl = new URL(
      `/api/v1/discord/war-counters/${encodeURIComponent(id)}`,
      this.baseUrl,
    ).toString();
    return this.request({ method: 'get', url: endpointUrl }, RetryMode.SAFE);
  }

  /** Fetch the current persisted Milcom objective for room reconciliation. */
  async getMilcomObjective(id) {
    const endpointUrl = new URL(
      `/api/v1/discord/milcom/objectives/${encodeURIComponent(id)}`,
      this.baseUrl,
    ).toString();
    return this.request({ method: 'get', url: endpointUrl }, RetryMode.SAFE);
  }

  /**
   * Submit a new application on behalf of a Discord user.
   * @param {{ nation_id: number, discord_user_id: string, discord_username: string }} payload application payload
   * @returns {Promise<any>} Nexus response containing application and config
   */
  async createApplication(payload) {
    const endpointUrl = new URL('/api/v1/discord/applications', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.NEVER);
  }

  /**
   * Attach a Discord channel to an application for transcript correlation.
   * @param {{ application_id: number|string, discord_channel_id: string }} payload association payload
   * @returns {Promise<any>} Nexus response
   */
  async attachApplicationChannel(payload) {
    const endpointUrl = new URL('/api/v1/discord/applications/attach-channel', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Attach a Discord channel/thread to a war counter.
   * @param {{ war_counter_id: number|string, discord_channel_id: string }} payload association payload
   * @returns {Promise<any>} Nexus response
   */
  async attachWarCounterChannel(payload) {
    const endpointUrl = new URL('/api/v1/discord/war-counters/attach-channel', this.baseUrl).toString();
    const options = {
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.#isV2Relay()
          ? this.#serviceRelayHeaders('war-counters.attach-channel', { method: 'post', url: endpointUrl, data: payload })
          : this.#serviceRelayHeaders('war-counters.attach-channel')),
      },
    };
    return this.request(options, RetryMode.IDEMPOTENT);
  }

  /**
   * Attach a checkpointed Discord room to a Milcom objective and dispatch.
   * @param {{ objective_id: number, dispatch_id: number, discord_channel_id: string }} payload association payload
   * @returns {Promise<any>} Nexus response
   */
  async attachMilcomObjectiveRoom(payload) {
    const endpointUrl = new URL(
      '/api/v1/discord/milcom/objectives/attach-room',
      this.baseUrl,
    ).toString();

    const options = {
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.#isV2Relay()
          ? this.#serviceRelayHeaders('milcom.objectives.attach-room', { method: 'post', url: endpointUrl, data: payload })
          : this.#serviceRelayHeaders('milcom.objectives.attach-room')),
      },
    };
    return this.request(options, RetryMode.IDEMPOTENT);
  }

  /**
   * Archive a war counter in Nexus.
   * @param {{ war_counter_id: number|string, moderator_discord_id: string }} payload archive request payload
   * @returns {Promise<{ counter?: any, archived?: boolean, already_archived?: boolean }>} Nexus response
   */
  async archiveWarCounter(payload, actor) {
    const endpointUrl = new URL('/api/v1/discord/war-counters/archive', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...this.#discordActorHeaders(actor, true, {
          method: 'post', url: endpointUrl, data: payload, action: 'war-counters.archive',
        }),
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Sweep the main bank into the primary enabled offshore.
   * @param {{ moderator_discord_id: string, note?: string }} payload sweep request payload
   * @returns {Promise<any>} Nexus response
   */
  async sweepPrimaryOffshore(payload, actor) {
    const endpointUrl = new URL('/api/v1/discord/offshores/sweep-primary', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...this.#discordActorHeaders(actor, true, {
          method: 'post', url: endpointUrl, data: payload, action: 'offshores.sweep-primary',
        }),
      },
    }, RetryMode.IDEMPOTENT);
  }

  /** Preview fresh main-bank balances before an authorized offshore sweep. */
  previewPrimaryOffshoreSweep(actor, payload) {
    return this.#requestDiscord('offshores/sweep-primary/preview', {
      method: 'post',
      data: payload,
      actor: {
        ...actor,
        discordCommand: 'sweepbank',
        discordAction: 'sweepbank',
      },
      retryMode: RetryMode.NEVER,
    });
  }

  /** Confirm an opaque, balance-versioned offshore sweep intent. */
  confirmPrimaryOffshoreSweep(actor, payload) {
    return this.#requestDiscord('offshores/sweep-primary/confirm', {
      method: 'post',
      data: payload,
      actor: {
        ...actor,
        discordCommand: 'sweepbank',
        discordAction: 'sweepbank',
      },
      retryMode: RetryMode.IDEMPOTENT,
    });
  }

  /**
   * Log a Discord message to Nexus for transcript storage.
   * @param {{ discord_channel_id: string, discord_message_id: string, discord_user_id: string, discord_username: string, content: string, sent_at: number }} payload message payload; Nexus derives staff status
   * @returns {Promise<any>} Nexus response indicating logging status
   */
  async logApplicationMessage(payload) {
    const endpointUrl = new URL('/api/v1/discord/applications/messages', this.baseUrl).toString();
    const options = {
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.#isV2Relay()
          ? this.#serviceRelayHeaders('applications.message', { method: 'post', url: endpointUrl, data: payload })
          : {}),
      },
    };
    return this.request(options, RetryMode.IDEMPOTENT);
  }

  /**
   * Submit an intel report captured from Discord to Nexus.
   * @param {{ report: string, source?: string }} payload intel payload containing the raw in-game text
   * @returns {Promise<any>} Nexus response with parsed intel details
   */
  async sendIntelReport(payload) {
    const endpointUrl = new URL('/api/v1/discord/intel', this.baseUrl).toString();
    const options = {
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.#isV2Relay()
          ? this.#serviceRelayHeaders('intel.report', { method: 'post', url: endpointUrl, data: payload })
          : {}),
      },
    };
    return this.request(options, RetryMode.IDEMPOTENT);
  }

  /**
   * Approve an applicant via Nexus.
   * @param {{ applicant_discord_id: string, moderator_discord_id: string, approval_request_id?: string }} payload approval payload
   * @returns {Promise<any>} Nexus response containing config for post-approval actions
   */
  async approveApplication(payload, actor) {
    const endpointUrl = new URL('/api/v1/discord/applications/approve', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...this.#discordActorHeaders(actor, true, {
          method: 'post', url: endpointUrl, data: payload, action: 'applications.approve',
        }),
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Deny an applicant via Nexus.
   * @param {{ applicant_discord_id: string, moderator_discord_id: string, denial_request_id?: string }} payload denial payload
   * @returns {Promise<any>} Nexus response
   */
  async denyApplication(payload, actor) {
    const endpointUrl = new URL('/api/v1/discord/applications/deny', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...this.#discordActorHeaders(actor, true, {
          method: 'post', url: endpointUrl, data: payload, action: 'applications.deny',
        }),
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Exchange a Discord-issued verification code with Nexus to link user accounts.
   * Always returns a normalized outcome instead of throwing so callers can render friendly errors.
   * @param {object} payload verification payload to send to Nexus
   * @param {string} payload.token verification code provided by the user
   * @param {string} payload.discord_id Discord user snowflake ID
   * @param {string} payload.discord_username Discord username (non-unique)
   * @param {string} [payload.discord_global_name] Discord global display name, if available
   * @param {string} [payload.discord_discriminator] Legacy discriminator/tag when present
   * @param {string} [payload.discord_avatar] Fully-qualified avatar URL for auditing
   * @param {object} [payload.metadata] Optional metadata for troubleshooting/auditing
   * @returns {Promise<{ success: boolean, data?: any, error?: { status: number | null, code: string, message: string, details?: any } }>}
   */
  async verifyUser(payload) {
    const endpointUrl = new URL('/api/v1/discord/verify', this.baseUrl).toString();

    // Mask secrets before logging to avoid leaking user-provided codes.
    const maskedPayload = {
      ...payload,
      token: '[REDACTED]',
    };

    this.logger.info('Sending verification request to Nexus', {
      url: endpointUrl,
      discordId: maskedPayload.discord_id ?? null,
    });

    try {
      const response = await this.http.post(endpointUrl, payload, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      this.logger.info('Verification request succeeded', {
        status: response.status,
        endpoint: endpointUrl,
      });

      return { success: true, data: response.data };
    } catch (error) {
      // Axios error classification: response (API returned an error), request (no response), or config.
      if (error.response) {
        const { status, data } = error.response;

        const errorCode = this.#mapStatusToErrorCode(status, data);
        const message = this.#deriveErrorMessage(status, data);
        const details = this.#sanitizeErrorData(data);

        const normalized = {
          success: false,
          status,
          code: errorCode,
          message,
          details,
          error: {
            status,
            code: errorCode,
            message,
            details,
          },
        };

        this.logger.warn('Verification request failed with API response', {
          status,
          endpoint: endpointUrl,
          code: errorCode,
        });

        return normalized;
      }

      if (error.request) {
        // Request was sent but no response received.
        this.logger.error('Verification request reached Nexus but no response was received', error.message ?? error);
        return {
          success: false,
          status: null,
          code: 'NETWORK_ERROR',
          message: 'Unable to reach Nexus right now. Please try again shortly.',
          error: {
            status: null,
            code: 'NETWORK_ERROR',
            message: 'Unable to reach Nexus right now. Please try again shortly.',
          },
        };
      }

      // Something went wrong constructing the request before it could be sent.
      this.logger.error('Unexpected verification failure before request was sent', error);
      return {
        success: false,
        status: null,
        code: 'UNEXPECTED_ERROR',
        message: 'An unexpected error occurred while preparing your verification.',
        error: {
          status: null,
          code: 'UNEXPECTED_ERROR',
          message: 'An unexpected error occurred while preparing your verification.',
        },
      };
    }
  }

  async #delay(durationMs) {
    await this.sleep(durationMs);
  }

  #isV2Relay() {
    return this.relaySigner?.protocolVersion === 2 && Boolean(this.connectionContext?.connectionId);
  }

  #assertQueueBinding(response, connectionContext) {
    const item = response?.data?.item
      ?? (response?.data?.connection_id ? response.data : null)
      ?? (response?.item?.connection_id ? response.item : null);
    const emptyClaim = response === null
      || response === undefined
      || response?.data === null
      || response?.item === null
      || response?.data?.item === null;
    if (emptyClaim) return;
    if (item === null) {
      throw new ApiContractError('Nexus returned a v2 queue claim without a connection-bound item.', {
        code: 'INVALID_QUEUE_BINDING',
        details: { field: 'item' },
      });
    }
    const expected = {
      connection_id: connectionContext.connectionId,
      application_id: connectionContext.applicationId,
      guild_id: connectionContext.guildId,
      generation: connectionContext.generation,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (item[field] !== value) {
        throw new ApiContractError('Nexus returned a queue item with an invalid connection binding.', {
          code: 'INVALID_QUEUE_BINDING',
          details: { field },
        });
      }
    }
  }

  #discordActorHeaders(actor, requireInteractionId, request = {}) {
    const discordUserId = `${actor?.discordUserId ?? actor?.userId ?? ''}`.trim();
    const discordGuildId = `${actor?.discordGuildId ?? actor?.guildId ?? ''}`.trim();
    const discordInteractionId = `${actor?.discordInteractionId ?? actor?.interactionId ?? ''}`.trim();

    if (!/^\d{17,20}$/.test(discordUserId) || !/^\d{17,20}$/.test(discordGuildId)) {
      throw new TypeError('Discord actor context requires valid user and guild snowflakes.');
    }
    if (requireInteractionId && !/^\d{17,20}$/.test(discordInteractionId)) {
      throw new TypeError('Discord write requests require a valid interaction snowflake.');
    }
    if (this.connectionContext && (
      discordGuildId !== this.connectionContext.guildId
      || (actor?.discordApplicationId && actor.discordApplicationId !== this.connectionContext.applicationId)
      || (actor?.discordConnectionId && actor.discordConnectionId !== this.connectionContext.connectionId)
      || (actor?.discordConnectionGeneration && Number(actor.discordConnectionGeneration) !== this.connectionContext.generation)
    )) {
      throw new TypeError('Discord actor context does not match the resolved Nexus connection.');
    }

    if (!this.relaySigner) {
      throw new TypeError('Discord actor requests require a configured relay signer.');
    }

    const signedRequest = this.#isV2Relay() && request.url
      ? { ...request, url: this.#canonicalRequestUrl(request.url) }
      : request;
    return this.relaySigner.interactionHeaders({
      ...actor,
      discordUserId,
      discordGuildId,
      discordInteractionId,
      discordAction: request.action ?? actor?.discordAction ?? actor?.action ?? actor?.discordCommand ?? actor?.command,
    }, {
      ...signedRequest,
      connectionContext: this.connectionContext,
    });
  }

  #serviceRelayHeaders(action, request = {}) {
    if (!this.relaySigner) {
      throw new TypeError('Discord service requests require a configured relay signer.');
    }
    if (this.#isV2Relay() && !V2_SERVICE_PROOF_ACTIONS.includes(action)) {
      throw new TypeError(`Unsupported v2 service proof action: ${action}`);
    }

    const signedRequest = this.#isV2Relay() && request.url
      ? { ...request, url: this.#canonicalRequestUrl(request.url) }
      : request;
    return this.relaySigner.serviceHeaders(action, {
      ...signedRequest,
      connectionContext: this.connectionContext,
    });
  }

  #canonicalRequestUrl(value) {
    const raw = `${value}`;
    const parsed = new URL(raw, this.baseUrl);
    const targetInput = raw.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)
      ? raw
      : parsed.toString();
    const target = normalizePathQuery(targetInput, { rejectEncodedUnreserved: false });
    return `${parsed.origin}${target}`;
  }

  #unwrapDiscordEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new ApiContractError('Nexus returned a malformed Discord response.');
    }

    if (envelope.error !== undefined) {
      const error = envelope.error;
      if (!error || typeof error !== 'object' || typeof error.code !== 'string' || error.code.trim() === '') {
        throw new ApiContractError('Nexus returned a malformed Discord error response.');
      }
      throw new ApiContractError(
        typeof error.message === 'string' && error.message.trim() !== ''
          ? error.message
          : 'Nexus rejected the request.',
        { code: error.code, details: error.details ?? null },
      );
    }

    if (!Object.hasOwn(envelope, 'data') || envelope?.meta?.contract_version !== 1) {
      throw new ApiContractError('Nexus returned an unsupported Discord response contract.');
    }

    return envelope.data;
  }

  #isRetryableError(error) {
    if (!error) {
      return false;
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return true;
    }

    if (!error.response) {
      return true;
    }

    const status = error.response.status;
    return status === 408 || status === 429 || status >= 500;
  }

  #retryDelay(error, attempt) {
    const headers = error?.response?.headers;
    const retryAfterHeader = headers?.get?.('retry-after') ?? headers?.['retry-after'];
    const retryAfter = this.#parseRetryAfter(retryAfterHeader);
    if (retryAfter !== null) {
      return retryAfter;
    }

    const base = 500;
    const exponential = base * 2 ** (attempt - 1);
    const jitter = Math.floor(this.random() * Math.min(exponential * 0.25, 1000));
    return exponential + jitter;
  }

  #parseRetryAfter(value) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.ceil(seconds * 1000), 5 * 60 * 1000);
    }

    const date = Date.parse(String(value));
    if (Number.isNaN(date)) {
      return null;
    }

    return Math.min(Math.max(date - Date.now(), 0), 5 * 60 * 1000);
  }

  #mapStatusToErrorCode(status, data) {
    if (status === 400) {
      return 'VALIDATION_ERROR';
    }

    if (status === 401 || status === 403) {
      return 'AUTHENTICATION_FAILED';
    }

    if (status === 404) {
      return 'NOT_FOUND';
    }

    if (status === 409) {
      return 'CONFLICT';
    }

    if (status >= 500) {
      return 'SERVER_ERROR';
    }

    // Fall back to any server-provided error code to aid troubleshooting.
    if (typeof data?.code === 'string' && data.code.trim() !== '') {
      return data.code;
    }

    return 'API_ERROR';
  }

  #deriveErrorMessage(status, data) {
    if (typeof data?.message === 'string' && data.message.trim() !== '') {
      return data.message;
    }

    if (status === 400) {
      return 'The verification code appears invalid or has expired.';
    }

    if (status === 401 || status === 403) {
      return 'Authentication with Nexus failed. Please contact an administrator.';
    }

    if (status === 404) {
      return 'No verification request was found for that code.';
    }

    if (status === 409) {
      return 'This verification request was already used or the account is already linked.';
    }

    if (status >= 500) {
      return 'Nexus is unavailable right now. Please try again later.';
    }

    return 'An unexpected error occurred while verifying your account.';
  }

  #sanitizeErrorData(data) {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const clone = { ...data };

    if (clone.token) {
      clone.token = '[REDACTED]';
    }

    return clone;
  }
}
