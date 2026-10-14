import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ProjectConfig } from '../core/types.js';
import {
  BASE_CHILD_ENV_VARS,
  buildChildEnv,
  collectSecretValues,
  isSensitiveEnvName,
  redactSecrets,
} from './env-scrub.js';

// ---------------------------------------------------------------------------
// isSensitiveEnvName
// ---------------------------------------------------------------------------

test('isSensitiveEnvName flags credentials and agent internals', () => {
  const sensitive = [
    'SC_API_KEY', 'SC_MODEL', 'SC_BASE_URL', 'SC_CONFIG_PATH', 'sc_api_key',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NVIDIA_API_KEY', 'API_KEY',
    'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'MY_SESSION_TOKEN', '_authToken',
    'AWS_SECRET_ACCESS_KEY', 'CLIENT_SECRET', 'MY_SECRET',
    'DB_PASSWORD', 'PGPASSFILE_password', 'PASSWD_FILE', 'PASSPHRASE',
    'AWS_ACCESS_KEY_ID', 'SSH_PRIVATE_KEY', 'SIGNING_KEY', 'ENCRYPTION_KEY_FILE',
    'REGISTRY_CREDENTIALS', 'DOCKER_CREDS',
    'MY_AUTH', 'REGISTRY_AUTH_TOKEN',
    'BEARER', 'OAUTH_BEARER',
    'MY_PUBLIC_KEY', // *_KEY is credential-shaped — dropped even if public
  ];
  for (const name of sensitive) {
    assert.equal(isSensitiveEnvName(name), true, name);
  }
});

test('isSensitiveEnvName leaves ordinary vars alone', () => {
  const safe = [
    'PATH', 'HOME', 'SHELL', 'TERM', 'USER', 'PWD', 'TMPDIR', 'LANG',
    'NODE_ENV', 'DATABASE_URL', 'MY_KEYSTORE', 'MONKEY', 'GIT_AUTHOR_NAME',
    'GIT_COMMITTER_EMAIL', 'HTTP_PROXY', 'AUTHOR_NAME', 'OPENAI_MODEL',
    'SSH_AUTH_SOCK', 'SSH_AGENT_PID', // agent sockets grant capability, not secrets
  ];
  for (const name of safe) {
    assert.equal(isSensitiveEnvName(name), false, name);
  }
});

// ---------------------------------------------------------------------------
// buildChildEnv
// ---------------------------------------------------------------------------

test('buildChildEnv keeps the safe base set and drops everything else', () => {
  const env = buildChildEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    SHELL: '/bin/sh',
    TERM: 'xterm',
    USER: 'agent',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp',
    TMP: '/tmp',
    TEMP: '/tmp',
    SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\cmd.exe',
    PWD: '/work',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@h/db',
    RANDOM_CUSTOM: 'x',
  });
  for (const name of ['PATH', 'HOME', 'SHELL', 'TERM', 'USER', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'COMSPEC', 'PWD']) {
    assert.ok(name in env, `expected ${name} to pass through`);
  }
  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.RANDOM_CUSTOM, undefined);
});

test('buildChildEnv strips credential-shaped vars unconditionally', () => {
  const env = buildChildEnv({
    PATH: '/usr/bin',
    SC_API_KEY: 'sk-sc',
    OPENAI_API_KEY: 'sk-openai',
    NVIDIA_API_KEY: 'nvapi-x',
    GH_TOKEN: 'ghp-x',
    MY_TOKEN: 't',
    AWS_SECRET_ACCESS_KEY: 's',
    DB_PASSWORD: 'p',
    SC_MODEL: 'llama3.2', // agent internals do not leak either
  });
  assert.deepEqual(Object.keys(env).sort(), ['PATH']);
});

test('buildChildEnv allowedEnvVars can add names but never re-add credentials', () => {
  const env = buildChildEnv(
    {
      PATH: '/usr/bin',
      NPM_CONFIG_REGISTRY: 'https://npm.corp',
      EDITOR_CUSTOM_FLAG: '1',
      MY_API_KEY: 'must-not-pass',
      SC_CUSTOM: 'no',
    },
    ['NPM_CONFIG_REGISTRY', 'editor_custom_flag', 'MY_API_KEY', 'SC_CUSTOM', 'bogus-name!'],
  );
  assert.equal(env.NPM_CONFIG_REGISTRY, 'https://npm.corp');
  assert.equal(env.EDITOR_CUSTOM_FLAG, '1'); // case-insensitive name match
  assert.equal(env.MY_API_KEY, undefined);
  assert.equal(env.SC_CUSTOM, undefined);
});

test('buildChildEnv matches base names case-insensitively (Windows spellings)', () => {
  const env = buildChildEnv({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', home: '/u' });
  assert.equal(env.Path, 'C:\\bin');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.home, '/u');
});

test('buildChildEnv base list stays credential-free by construction', () => {
  // Regression guard: if a credential-shaped name ever lands in the base list
  // the strip order (sensitive → allowed) still filters it — but flag it so
  // the list stays clean.
  for (const name of BASE_CHILD_ENV_VARS) {
    assert.equal(isSensitiveEnvName(name), false, `${name} should not be credential-shaped`);
  }
});

// ---------------------------------------------------------------------------
// collectSecretValues
// ---------------------------------------------------------------------------

test('collectSecretValues gathers credential env values and config keys', () => {
  const config: ProjectConfig = {
    model: { provider: 'openai-compatible', baseUrl: 'http://x/v1', model: 'm', apiKey: 'cfg-model-key-123' },
    profiles: {
      openai: { apiKey: 'cfg-profile-key-456' },
      placeholder: { apiKey: '<YOUR_OPENAI_KEY>' },
    },
  };
  const secrets = collectSecretValues(
    {
      SC_API_KEY: 'env-sc-key-abc',
      OPENAI_API_KEY: 'env-openai-key',
      SC_MODEL: 'llama3.2-verylong', // SC_* but not credential-shaped → not a secret
      SHORT_KEY: 'abc', // too short to safely mask
      HTTP_PROXY: 'http://corp:8080', // no userinfo → not a secret
      HTTPS_PROXY: 'https://user:passw0rd@proxy:8443', // creds-bearing URL → masked
      PATH: '/usr/bin:/bin',
    },
    config,
  );
  assert.ok(secrets.includes('env-sc-key-abc'));
  assert.ok(secrets.includes('env-openai-key'));
  assert.ok(secrets.includes('cfg-model-key-123'));
  assert.ok(secrets.includes('cfg-profile-key-456'));
  assert.ok(secrets.includes('https://user:passw0rd@proxy:8443'));
  assert.ok(!secrets.includes('llama3.2-verylong'));
  assert.ok(!secrets.includes('abc'));
  assert.ok(!secrets.includes('http://corp:8080'));
  assert.ok(!secrets.includes('<YOUR_OPENAI_KEY>'));
  // longest-first ordering so overlapping values mask the long form first
  assert.ok(secrets.every((s, i) => i === 0 || secrets[i - 1].length >= s.length));
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

test('redactSecrets masks every occurrence and leaves the rest intact', () => {
  const out = redactSecrets('key=sk-abc123 then again sk-abc123; PATH=/usr/bin', ['sk-abc123']);
  assert.equal(out, 'key=*** then again ***; PATH=/usr/bin');
  assert.equal(redactSecrets('nothing here', ['sk-abc123']), 'nothing here');
  assert.equal(redactSecrets('', ['x']), '');
});
