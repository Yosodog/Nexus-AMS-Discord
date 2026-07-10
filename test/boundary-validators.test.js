import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBoundedString,
  isDiscordSnowflake,
  isHttpUrl,
  isUuid,
  normalizeBoundedString,
  toPositiveInteger,
} from '../src/utils/boundaryValidators.js';

test('boundary validators accept canonical ids and reject malformed values', () => {
  assert.equal(isDiscordSnowflake('123456789012345678'), true);
  assert.equal(isDiscordSnowflake('channel-1'), false);
  assert.equal(isDiscordSnowflake('000000000000000000'), false);
  assert.equal(isDiscordSnowflake(123456789012345678), false);
  assert.equal(isUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(toPositiveInteger('42'), 42);
  assert.equal(toPositiveInteger(0), null);
  assert.equal(isHttpUrl('http://localhost:8000/api'), true);
  assert.equal(isHttpUrl('https://nexus.example/api', { httpsOnly: true }), true);
  assert.equal(isHttpUrl('http://nexus.example/api', { httpsOnly: true }), false);
  assert.equal(isHttpUrl('file:///tmp/nexus'), false);
  assert.equal(isHttpUrl('not a url'), false);
  assert.equal(normalizeBoundedString('  room-name  ', { minLength: 1, maxLength: 20 }), 'room-name');
  assert.equal(normalizeBoundedString('too-long', { maxLength: 3 }), null);
  assert.equal(isBoundedString('prefix', { minLength: 1, maxLength: 10 }), true);
  assert.equal(isBoundedString(123, { maxLength: 10 }), false);
});
