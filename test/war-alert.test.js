import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/services/queueActions/warAlert.js';
import { createLogger } from './helpers.js';

const CHANNEL_ID = '123456789012345678';

const renderWarAlert = async (counter) => {
  let outgoing;
  const result = await execute({
    id: 'war-alert-1',
    created_at: '2026-08-15T12:00:00Z',
    payload: {
      channel_id: CHANNEL_ID,
      war_id: 701,
      war_url: 'https://politicsandwar.com/nation/war/timeline/war=701',
      counter,
      attacker: { nation_name: 'Attacker Nation', leader_name: 'Attacker' },
      defender: { nation_name: 'Defender Nation', leader_name: 'Defender' },
    },
  }, {
    logger: createLogger(),
    canContinue: () => true,
    resolveTextChannel: async () => ({
      guildId: '223456789012345678',
      isTextBased: () => true,
    }),
    send: async (_channel, _command, _step, message) => {
      outgoing = message;
    },
  });

  assert.deepEqual(result, { success: true });
  return outgoing.embeds[0].toJSON();
};

test('WAR_ALERT labels a safe Milcom v2 counter link as Review fast counter', async () => {
  const embed = await renderWarAlert({
    kind: 'milcom_incident',
    id: 42,
    url: 'https://nexus.example/admin/milcom/counters?incident=42',
  });

  assert.match(embed.description, /\[Review fast counter\]\(https:\/\/nexus\.example\/admin\/milcom\/counters\?incident=42\)/);
  assert.doesNotMatch(embed.description, /Counter .*42/);
});

test('WAR_ALERT retains the legacy counter label', async () => {
  const embed = await renderWarAlert({
    id: 77,
    url: 'https://nexus.example/admin/war-counters/77',
  });

  assert.match(embed.description, /\[Counter \\#77\]\(https:\/\/nexus\.example\/admin\/war-counters\/77\)/);
});

test('WAR_ALERT omits the counter link when counter data is absent', async () => {
  const embed = await renderWarAlert(undefined);

  assert.doesNotMatch(embed.description, /Review fast counter|Counter #/);
});

test('WAR_ALERT omits unsafe counter URLs', async () => {
  const embed = await renderWarAlert({
    kind: 'milcom_incident',
    id: 42,
    url: 'javascript:alert(1)',
  });

  assert.doesNotMatch(embed.description, /Review fast counter|javascript:/);
});
