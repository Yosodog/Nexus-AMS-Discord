import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contents = (file) => fs.readFileSync(path.join(repositoryRoot, file), 'utf8');

test('the shipped image is pinned, production-only, non-root, healthy, and signal-safe', () => {
  const dockerfile = contents('Dockerfile');
  const multiArchitectureDigest = 'sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

  assert.match(
    dockerfile,
    /FROM node:22\.23\.1-bookworm-slim@sha256:[a-f0-9]{64} AS dependencies/,
  );
  assert.match(
    dockerfile,
    /FROM node:22\.23\.1-bookworm-slim@sha256:[a-f0-9]{64} AS runtime/,
  );
  assert.equal(
    dockerfile.match(new RegExp(multiArchitectureDigest, 'g'))?.length,
    2,
    'both stages must pin the reviewed multi-architecture index',
  );
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /HEALTHCHECK .*CMD \["node", "src\/healthcheck\.js"\]/);
  assert.match(dockerfile, /STOPSIGNAL SIGTERM/);
  assert.match(dockerfile, /CMD \["node", "src\/bot\.js"\]/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+/);
});

test('the Compose service preserves the dedicated-mode security and drain contract', () => {
  const compose = contents('compose.yaml');

  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /init:\s*true/);
  assert.match(compose, /stop_grace_period:\s*320s/);
  assert.match(compose, /security_opt:\s*\n\s*- no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /pids_limit:\s*128/);
  assert.match(compose, /env_file:\s*\n\s*- \.env/);
  assert.match(compose, /\.\/data:\/app\/data/);
  assert.doesNotMatch(compose, /ports:/);
});

test('the Docker build context excludes credentials and runtime state', () => {
  const dockerignore = contents('.dockerignore');
  const gitignore = contents('.gitignore');

  for (const entry of [
    '.env',
    '.env.*',
    'relay-keys.env',
    'data',
    'node_modules',
    '.git',
    'coverage',
    'test-results',
  ]) {
    assert.match(dockerignore, new RegExp(`^${entry.replace('.', '\\.')}\\/?$`, 'm'));
  }
  assert.match(gitignore, /^relay-keys\.env\/?$/m);
});
