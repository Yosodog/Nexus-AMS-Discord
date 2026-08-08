import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import Ajv from 'ajv';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = path.resolve(TEST_DIR, '../contracts/discord');
const VALID_DIR = path.join(CONTRACT_DIR, 'fixtures/valid');
const INVALID_DIR = path.join(CONTRACT_DIR, 'fixtures/invalid');
const SCHEMA_SUFFIX = '.schema.json';

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const schemaFiles = fs.readdirSync(CONTRACT_DIR)
  .filter((file) => file.endsWith(SCHEMA_SUFFIX))
  .sort();
const schemaNames = schemaFiles.map((file) => file.slice(0, -SCHEMA_SUFFIX.length));
const schemaByName = new Map(
  schemaFiles.map((file, index) => [schemaNames[index], readJson(path.join(CONTRACT_DIR, file))]),
);
const ajv = new Ajv({ allErrors: true, strict: true });
const validatorByName = new Map(
  [...schemaByName.entries()].map(([name, schema]) => [name, ajv.compile(schema)]),
);

const fixtureFiles = (directory) => fs.readdirSync(directory)
  .filter((file) => file.endsWith('.json'))
  .sort();

const fixtureContract = (file) => {
  const matches = schemaNames.filter((name) => file.startsWith(`${name}.`));
  assert.equal(matches.length, 1, `fixture ${file} must map to exactly one schema`);
  return matches[0];
};

const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
};

const fixedPrivateKey = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b657004220420'
      + '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    'hex',
  ),
  format: 'der',
  type: 'pkcs8',
});
const fixedPublicKey = createPublicKey(fixedPrivateKey);

test('parses and compiles every versioned schema', () => {
  assert.equal(schemaFiles.length, 5);
  for (const [name, schema] of schemaByName) {
    assert.equal(schema.type, 'object', `${name} must define an object contract`);
    assert.equal(schema.additionalProperties, false, `${name} envelope must be closed`);
    assert.equal(schema.properties.contract.const, schemaNames
      .find((candidate) => candidate === name)
      .replace(/-v[0-9]+$/, ''), `${name} discriminator must match its filename`);
    assert.equal(typeof schema.properties.contract_version.const, 'number');
    assert.ok(schema.required.includes('contract'));
    assert.ok(schema.required.includes('contract_version'));
  }
});

test('fixture coverage includes valid and invalid cases for every schema', () => {
  const validFiles = fixtureFiles(VALID_DIR);
  const invalidFiles = fixtureFiles(INVALID_DIR);
  const covered = (files) => new Set(files.map(fixtureContract));

  assert.deepEqual([...covered(validFiles)].sort(), [...schemaNames].sort());
  assert.deepEqual([...covered(invalidFiles)].sort(), [...schemaNames].sort());
  for (const name of schemaNames) {
    assert.ok(validFiles.some((file) => file.startsWith(`${name}.`)), `${name} needs a valid fixture`);
    assert.ok(invalidFiles.some((file) => file.startsWith(`${name}.`)), `${name} needs an invalid fixture`);
  }
});

for (const file of fixtureFiles(VALID_DIR)) {
  test(`accepts valid fixture ${file}`, () => {
    const name = fixtureContract(file);
    const validate = validatorByName.get(name);
    const fixture = readJson(path.join(VALID_DIR, file));
    assert.equal(validate(fixture), true, validate.errors
      ? JSON.stringify(validate.errors)
      : `expected ${file} to validate`);
  });
}

for (const file of fixtureFiles(INVALID_DIR)) {
  test(`rejects invalid fixture ${file}`, () => {
    const name = fixtureContract(file);
    const validate = validatorByName.get(name);
    const fixture = readJson(path.join(INVALID_DIR, file));
    assert.equal(validate(fixture), false, `expected ${file} to be rejected`);
  });
}

test('rotation fixture binds the manifest to current and next key metadata', () => {
  const manifest = readJson(path.join(VALID_DIR, 'capability-manifest-v1.rotation.json'));
  assert.equal(manifest.key_id, manifest.keys.current.key_id);
  assert.ok(manifest.keys.next);
  assert.notEqual(manifest.keys.current.key_id, manifest.keys.next.key_id);
  assert.notEqual(manifest.keys.current.public_key, manifest.keys.next.public_key);
});

test('relay proof has a deterministic canonical Ed25519 signing vector', () => {
  const proof = readJson(path.join(VALID_DIR, 'relay-proof-v2.interaction.json'));
  const { signature: _signature, ...unsigned } = proof;
  const canonical = canonicalize(unsigned);
  const signingInput = `NEXUS-DISCORD-RELAY-PROOF-V2\n${canonical}`;
  const expectedCanonical = '{"app_id":"123456789012345678","body_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","connection_id":"11111111-2222-4333-8444-555555555555","contract":"relay-proof","contract_version":2,"expires_at":"2026-08-08T12:00:30Z","generation":7,"guild_id":"223456789012345678","idempotency_key":"33333333-4444-4555-8666-777777777777","issued_at":"2026-08-08T12:00:00Z","key_id":"relay-current-2026-01","proof":{"command":"applications.approve","interaction_id":"323456789012345678","type":"interaction","user_id":"423456789012345678"},"route":{"method":"POST","path":"/api/v1/discord/staff/applications/opaque/approve"}}';
  const expectedSignature = '6b9902af43d649ac8574f48bd971e27a9def758c66e657820d117cac439f1a03a10d3f36350aec4a18c4b904fa722903ab68205e658ca8b2896294108eccaf02';
  const actualSignature = sign(null, Buffer.from(signingInput), fixedPrivateKey).toString('hex');

  assert.equal(canonical, expectedCanonical);
  assert.equal(actualSignature, expectedSignature);
  assert.equal(proof.signature.value, expectedSignature);
  assert.equal(
    verify(null, Buffer.from(signingInput), fixedPublicKey, Buffer.from(actualSignature, 'hex')),
    true,
  );
});
