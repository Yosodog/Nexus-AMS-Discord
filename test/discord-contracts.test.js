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
const EXPECTED_SCHEMAS = [
  'capability-manifest-v1',
  'delivery-batch-v1',
  'delivery-receipt-v1',
  'relay-proof-v2',
  'route-endorsement-v1',
];
const DIRECTION_BY_SCHEMA = {
  'relay-proof-v2': ['discord-relay', 'nexus', 'discord-relay->nexus'],
  'delivery-receipt-v1': ['discord-relay', 'nexus', 'discord-relay->nexus'],
  'route-endorsement-v1': ['nexus', 'discord-relay', 'nexus->discord-relay'],
  'delivery-batch-v1': ['nexus', 'discord-relay', 'nexus->discord-relay'],
};

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

const privateKeyFromSeedStart = (start) => createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index + start)),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const fixedPrivateKey = privateKeyFromSeedStart(0);
const fixedNexusPrivateKey = privateKeyFromSeedStart(64);
const fixedPublicKey = createPublicKey(fixedPrivateKey);
const SIGNING_DOMAIN_BY_CONTRACT = {
  'relay-proof': 'NEXUS-DISCORD-RELAY-PROOF-V2',
  'capability-manifest': 'NEXUS-DISCORD-CAPABILITY-MANIFEST-V1',
  'route-endorsement': 'NEXUS-DISCORD-ROUTE-ENDORSEMENT-V1',
  'delivery-batch': 'NEXUS-DISCORD-DELIVERY-BATCH-V1',
  'delivery-receipt': 'NEXUS-DISCORD-DELIVERY-RECEIPT-V1',
};

const relayProofSigningMaterial = (document) => {
  const { signature: _signature, ...unsigned } = document;
  const canonical = canonicalize(unsigned);
  const signingInput = `NEXUS-DISCORD-RELAY-PROOF-V2\n${canonical}`;
  return {
    canonical,
    signingInput,
    signature: sign(null, Buffer.from(signingInput), fixedPrivateKey).toString('hex'),
  };
};

test('parses and compiles the exact versioned schema set', () => {
  assert.deepEqual(schemaNames, EXPECTED_SCHEMAS);
  for (const [name, schema] of schemaByName) {
    assert.equal(schema.type, 'object', `${name} must define an object contract`);
    assert.equal(schema.additionalProperties, false, `${name} envelope must be closed`);
    assert.equal(schema.properties.contract.const, name.replace(/-v[0-9]+$/, ''));
    assert.equal(typeof schema.properties.contract_version.const, 'number');
    for (const property of ['contract', 'contract_version', 'issuer', 'audience', 'key_scope', 'signature']) {
      assert.ok(schema.required.includes(property), `${name} must require ${property}`);
    }
  }
});

test('fixture coverage is exact and includes valid and invalid cases for every schema', () => {
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

test('signed fixtures use explicit issuer, audience, and direction-specific key scope', () => {
  for (const file of fixtureFiles(VALID_DIR)) {
    const name = fixtureContract(file);
    const fixture = readJson(path.join(VALID_DIR, file));
    if (name === 'capability-manifest-v1') {
      assert.equal(fixture.key_set.owner, fixture.issuer);
      assert.equal(fixture.key_set.scope, fixture.key_scope);
      assert.equal(fixture.key_id, fixture.key_set.current.key_id);
      continue;
    }
    assert.deepEqual([
      fixture.issuer,
      fixture.audience,
      fixture.key_scope,
    ], DIRECTION_BY_SCHEMA[name]);
  }
});

test('valid fixtures use the private key for their own issuer direction', () => {
  for (const file of fixtureFiles(VALID_DIR)) {
    const fixture = readJson(path.join(VALID_DIR, file));
    const { signature: _signature, ...unsigned } = fixture;
    const privateKey = fixture.issuer === 'nexus' ? fixedNexusPrivateKey : fixedPrivateKey;
    const signingInput = `${SIGNING_DOMAIN_BY_CONTRACT[fixture.contract]}\n${canonicalize(unsigned)}`;
    const actualSignature = sign(null, Buffer.from(signingInput), privateKey).toString('hex');
    assert.equal(actualSignature, fixture.signature.value, `signature mismatch in ${file}`);
  }
});

test('manifests and endorsements use route templates, not actual request targets', () => {
  const nexusManifest = readJson(path.join(VALID_DIR, 'capability-manifest-v1.nexus.json'));
  const endorsement = readJson(path.join(VALID_DIR, 'route-endorsement-v1.allow.json'));
  const proof = readJson(path.join(VALID_DIR, 'relay-proof-v2.interaction.json'));

  assert.ok(nexusManifest.http_routes.every((route) => route.path_template.startsWith('/')));
  assert.ok(nexusManifest.http_routes.every((route) => !route.path_template.includes('?')));
  assert.equal(endorsement.route_template.path_template, '/api/v1/discord/delivery/receipts');
  assert.equal(Object.hasOwn(proof, 'route_template'), false);
  assert.match(proof.normalized_path_query, /\?/);
});

test('rotation fixtures keep current and next keys independent per direction', () => {
  const relay = readJson(path.join(VALID_DIR, 'capability-manifest-v1.rotation.json'));
  const nexus = readJson(path.join(VALID_DIR, 'capability-manifest-v1.nexus.json'));

  assert.equal(relay.key_set.owner, 'discord-relay');
  assert.equal(relay.key_set.scope, 'discord-relay->nexus');
  assert.ok(relay.key_set.next);
  assert.notEqual(relay.key_set.current.key_id, relay.key_set.next.key_id);
  assert.notEqual(relay.key_set.current.public_key, relay.key_set.next.public_key);
  assert.equal(nexus.key_set.owner, 'nexus');
  assert.equal(nexus.key_set.scope, 'nexus->discord-relay');
  assert.ok(nexus.key_set.next);
  assert.notEqual(nexus.key_set.current.key_id, nexus.key_set.next.key_id);
  assert.notEqual(nexus.key_set.current.public_key, nexus.key_set.next.public_key);
  assert.notEqual(relay.key_set.current.public_key, nexus.key_set.current.public_key);
});

test('delivery attempt ceiling is eight', () => {
  const batch = readJson(path.join(VALID_DIR, 'delivery-batch-v1.two-items.json'));
  assert.equal(batch.deliveries.at(-1).attempt, 8);
  assert.equal(schemaByName.get('delivery-batch-v1').definitions.delivery.properties.attempt.maximum, 8);
  assert.equal(
    schemaByName.get('capability-manifest-v1').definitions.limits.properties.max_delivery_attempts.maximum,
    8,
  );
});

test('relay proof has a deterministic canonical Ed25519 signing vector', () => {
  const proof = readJson(path.join(VALID_DIR, 'relay-proof-v2.interaction.json'));
  const material = relayProofSigningMaterial(proof);
  const expectedCanonical = '{"app_id":"123456789012345678","audience":"nexus","body_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","connection_id":"11111111-2222-4333-8444-555555555555","contract":"relay-proof","contract_version":2,"expires_at":"2026-08-08T12:00:30Z","generation":7,"guild_id":"223456789012345678","idempotency_key":"33333333-4444-4555-8666-777777777777","issued_at":"2026-08-08T12:00:00Z","issuer":"discord-relay","key_id":"relay-current-2026-01","key_scope":"discord-relay->nexus","method":"POST","normalized_path_query":"/api/v1/discord/staff/applications/opaque/approve?a=1&a=1&b=2","proof":{"action":"applications.approve","command":"applications","interaction_id":"323456789012345678","type":"interaction","user_id":"423456789012345678"}}';
  const expectedSignature = '186202c05ab0718902661c99630976fd2ecd9d859c2a4aca1a8f6d72613dba0f184e75489443057f379f194a4de9fabee669ac9388a20611ade5cf9c547e0a0f';

  assert.equal(material.canonical, expectedCanonical);
  assert.equal(material.signature, expectedSignature);
  assert.equal(proof.signature.value, expectedSignature);
  assert.equal(
    verify(null, Buffer.from(material.signingInput), fixedPublicKey, Buffer.from(material.signature, 'hex')),
    true,
  );
});

test('query ordering and canonical action tampering change relay signing input and signature', () => {
  const proof = readJson(path.join(VALID_DIR, 'relay-proof-v2.interaction.json'));
  const original = relayProofSigningMaterial(proof);
  const queryTampered = structuredClone(proof);
  queryTampered.normalized_path_query = '/api/v1/discord/staff/applications/opaque/approve?b=2&a=1&a=1';
  const actionTampered = structuredClone(proof);
  actionTampered.proof.action = 'applications.deny';

  const queryMaterial = relayProofSigningMaterial(queryTampered);
  const actionMaterial = relayProofSigningMaterial(actionTampered);
  assert.notEqual(queryMaterial.canonical, original.canonical);
  assert.notEqual(queryMaterial.signature, original.signature);
  assert.notEqual(actionMaterial.canonical, original.canonical);
  assert.notEqual(actionMaterial.signature, original.signature);
});
