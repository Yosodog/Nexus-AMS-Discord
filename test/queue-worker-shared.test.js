import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueWorker } from '../src/services/QueueWorker.js';
import { ConnectionResolver } from '../src/services/connection/ConnectionResolver.js';
import { createConnectionContext } from '../src/services/connection/ConnectionContext.js';
import { FairScheduler } from '../src/services/FairScheduler.js';
import { createLogger, waitFor } from './helpers.js';

const APP_ID = '123456789012345678';
const contexts = [
  createConnectionContext({
    mode: 'shared', protocolVersion: 2, applicationId: APP_ID,
    guildId: '223456789012345678', connectionId: '11111111-2222-4333-8444-555555555555',
    generation: 7, keyId: 'relay-a', endpointOrigin: 'https://nexus-a.example', capabilities: { commands: { nexus: 1 } },
    expiresAt: '2099-08-08T13:00:00Z',
  }),
  createConnectionContext({
    mode: 'shared', protocolVersion: 2, applicationId: APP_ID,
    guildId: '323456789012345678', connectionId: '66666666-7777-4777-8888-999999999999',
    generation: 3, keyId: 'relay-b', endpointOrigin: 'https://nexus-b.example', capabilities: { commands: { nexus: 1 } },
    expiresAt: '2099-08-08T13:00:00Z',
  }),
];

test('QueueWorker shares claim opportunities fairly and passes delivery context to the action runtime', async () => {
  const resolver = new ConnectionResolver({ mode: 'shared', applicationId: APP_ID, connections: contexts });
  const claimCounts = new Map(contexts.map((context) => [context.connectionId, 0]));
  const dispatches = [];
  const statuses = [];
  const services = new Map(contexts.map((context) => [context.connectionId, {
    claimDiscordQueue: async () => {
      const count = claimCounts.get(context.connectionId) + 1;
      claimCounts.set(context.connectionId, count);
      if (count > 1) return { data: null };
      return { data: { item: {
        id: `delivery-${context.connectionId}`,
        action: 'WAR_ALERT',
        lease_token: `lease-${context.connectionId}`,
        leased_until: new Date(Date.now() + 60_000).toISOString(),
        attempts: 1,
        connection_id: context.connectionId,
        application_id: context.applicationId,
        guild_id: context.guildId,
        generation: context.generation,
        dedupe_key: `dedupe-${context.connectionId}`,
      } } };
    },
    renewDiscordQueueLease: async () => ({ data: { leased_until: new Date(Date.now() + 60_000).toISOString() } }),
    updateDiscordQueueStatus: async (...args) => statuses.push(args),
  }]));

  const worker = new QueueWorker({
    apiService: null,
    dispatcher: null,
    logger: createLogger(),
    workerId: 'worker-shared',
    pollIntervalMs: 1,
    connectionResolver: resolver,
    scheduler: new FairScheduler(),
    apiServiceFactory: (context) => services.get(context.connectionId),
    dispatcherFactory: () => ({
      dispatch: async (_item, execution) => {
        dispatches.push(execution);
        return { success: true };
      },
    }),
  });

  worker.start();
  await waitFor(() => dispatches.length === 2, { timeoutMs: 1000 });
  await worker.stop();

  assert.deepEqual(dispatches.map((execution) => execution.connectionId), [
    contexts[0].connectionId,
    contexts[1].connectionId,
  ]);
  assert.equal(dispatches[0].deliveryContext.generation, contexts[0].generation);
  assert.equal(dispatches[1].deliveryContext.generation, contexts[1].generation);
  assert.equal(dispatches[0].applicationId, APP_ID);
  assert.equal(dispatches[1].applicationId, APP_ID);
  assert.equal(statuses.length, 2);
});

test('QueueWorker fences a leased action when its connection is revoked during execution', async () => {
  const [connection] = contexts;
  const resolver = new ConnectionResolver({ mode: 'shared', applicationId: APP_ID, connections: [connection] });
  const statuses = [];
  let canContinueBefore;
  let canContinueAfter;
  let claimed = false;
  const service = {
    claimDiscordQueue: async () => {
      if (claimed) return { data: null };
      claimed = true;
      return { data: { item: {
        id: 'delivery-revoked',
        action: 'WAR_ALERT',
        lease_token: 'lease-revoked',
        leased_until: new Date(Date.now() + 60_000).toISOString(),
        attempts: 1,
        connection_id: connection.connectionId,
        application_id: connection.applicationId,
        guild_id: connection.guildId,
        generation: connection.generation,
        dedupe_key: 'dedupe-revoked',
      } } };
    },
    renewDiscordQueueLease: async () => ({ data: { leased_until: new Date(Date.now() + 60_000).toISOString() } }),
    updateDiscordQueueStatus: async (...args) => statuses.push(args),
  };
  const worker = new QueueWorker({
    apiService: null,
    dispatcher: null,
    logger: createLogger(),
    workerId: 'worker-revocation',
    pollIntervalMs: 1,
    connectionResolver: resolver,
    scheduler: new FairScheduler(),
    apiServiceFactory: () => service,
    dispatcherFactory: () => ({
      dispatch: async (_item, execution) => {
        canContinueBefore = execution.canContinue();
        resolver.replace([]);
        canContinueAfter = execution.canContinue();
        return { success: true };
      },
    }),
  });

  worker.start();
  await waitFor(() => statuses.length === 1, { timeoutMs: 1000 });
  await worker.stop();

  assert.equal(canContinueBefore, true);
  assert.equal(canContinueAfter, false);
  assert.equal(statuses[0][1], 'failed');
  assert.equal(statuses[0][3].error_code, 'connection_revoked');
});
