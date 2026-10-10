import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import app from './app.js';
import { initializeAuth, getApiKey, getOrgId } from './auth.js';
import { getConfig } from './config.js';
import { logRequest, logResponse } from './logger.js';

const clientToken = 'test-client-secret';
const factoryKey = 'fk-test-upstream-secret';
const orgId = 'test-server-org';

function request(base, url, { method = 'GET', headers = {}, body } = {}) {
  if (Array.isArray(headers)) headers = ['Host', new URL(base).host, ...headers];
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(url, base), { method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('client authentication and Factory credential isolation', async t => {
  const envNames = ['FACTORY_API_KEY', 'FACTORY_ORG_ID', 'request_auth_token'];
  const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const config = getConfig();
  const savedConfig = structuredClone(config);
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({ url: req.url, headers: req.headers });
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'test-response', output: [], content: [], candidates: [],
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      input_tokens: 1
    }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(config, {
    dev_mode: false, proxies: [], model_redirects: {},
    models: ['openai', 'anthropic', 'google', 'common'].map(type => ({
      id: `test-${type}`, type, reasoning: 'auto'
    })),
    endpoint: [
      { name: 'openai', base_url: `${upstreamBase}/v1/responses` },
      { name: 'anthropic', base_url: `${upstreamBase}/v1/messages` },
      { name: 'google', base_url: `${upstreamBase}/v1/generate` },
      { name: 'common', base_url: `${upstreamBase}/v1/chat/completions` }
    ]
  });
  process.env.FACTORY_API_KEY = factoryKey;
  process.env.FACTORY_ORG_ID = orgId;
  process.env.request_auth_token = clientToken;
  initializeAuth();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await Promise.all([new Promise(resolve => server.close(resolve)),
      new Promise(resolve => upstream.close(resolve))]);
    Object.assign(config, savedConfig);
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  const endpoints = [
    ['/v1/models', 'GET'], ['/v1/chat/completions', 'POST'],
    ['/v1/responses', 'POST'], ['/v1/messages', 'POST'],
    ['/v1/messages/count_tokens', 'POST'], ['/v1/generate', 'POST']
  ];
  for (const [url, method] of endpoints) {
    await t.test(`${method} ${url} rejects absent, wrong, and Factory keys`, async () => {
      for (const headers of [{}, { authorization: 'Bearer wrong' },
        { authorization: `Bearer ${factoryKey}` }, { 'x-api-key': 'wrong' }]) {
        const res = await request(base, url, { method, headers });
        assert.equal(res.status, 401);
        assert.equal(JSON.parse(res.text).error.code, 'invalid_api_key');
        assert.equal(res.headers['access-control-allow-origin'], '*');
        assert.match(res.headers['www-authenticate'], /Bearer/);
        assert.ok(!res.text.includes(clientToken) && !res.text.includes(factoryKey));
      }
      assert.equal(upstreamRequests.length, 0);
    });
  }

  await t.test('auth runs before JSON parsing and does not accept query/body keys', async () => {
    for (const body of ['{invalid', JSON.stringify({ request_auth_token: clientToken })]) {
      assert.equal((await request(base, `/v1/messages?api_key=${clientToken}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body
      })).status, 401);
    }
    assert.equal(upstreamRequests.length, 0);
  });

  await t.test('valid Bearer and x-api-key clients can list models', async () => {
    for (const headers of [
      { authorization: `Bearer ${clientToken}` },
      { Authorization: `bEaReR ${clientToken}` },
      { 'X-API-Key': clientToken },
      { authorization: `Bearer ${clientToken}`, 'x-api-key': clientToken }
    ]) {
      const res = await request(base, '/v1/models', { headers });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.text).data.length, 4);
    }
  });

  await t.test('malformed, conflicting, and duplicate credential headers are rejected', async () => {
    const invalidHeaders = [
      { authorization: clientToken }, { authorization: `Basic ${clientToken}` },
      { authorization: 'Bearer' }, { authorization: `Bearer ${clientToken} extra` },
      { authorization: `Bearer ${clientToken}, Bearer ${clientToken}` },
      { authorization: 'Bearer wrong', 'x-api-key': clientToken },
      { authorization: `Bearer ${clientToken}`, 'x-api-key': 'wrong' },
      { authorization: '', 'x-api-key': clientToken },
      ['Authorization', `Bearer ${clientToken}`, 'authorization', `Bearer ${clientToken}`],
      ['X-API-Key', clientToken, 'x-api-key', clientToken]
    ];
    for (const headers of invalidHeaders) {
      assert.equal((await request(base, '/v1/models', { headers })).status, 401);
    }
  });

  await t.test('root health check and CORS preflight remain public', async () => {
    assert.equal((await request(base, '/')).status, 200);
    const res = await request(base, '/v1/messages', {
      method: 'OPTIONS', headers: { origin: 'https://example.test',
        'access-control-request-headers': 'authorization,x-api-key' }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['access-control-allow-headers'], /X-API-Key/);
    assert.equal(upstreamRequests.length, 0);
  });

  await t.test('every upstream route uses server Factory credentials for both client header formats', async () => {
    const routes = [
      ['/v1/responses', 'openai'], ['/v1/messages', 'anthropic'],
      ['/v1/messages/count_tokens', 'anthropic'], ['/v1/generate', 'google'],
      ...['openai', 'anthropic', 'google', 'common'].map(type => ['/v1/chat/completions', type])
    ];
    for (const clientHeaders of [{ authorization: `Bearer ${clientToken}` }, { 'x-api-key': clientToken }]) {
      for (const [url, type] of routes) {
        const previous = upstreamRequests.length;
        const res = await request(base, url, {
          method: 'POST', headers: { ...clientHeaders, 'content-type': 'application/json',
            'x-factory-org-id': 'client-spoofed-org' },
          body: JSON.stringify({ model: `test-${type}`, messages: [], input: [], contents: [], stream: false })
        });
        assert.equal(res.status, 200, `${url} (${type}): ${res.text}`);
        assert.equal(upstreamRequests.length, previous + 1);
        const sent = upstreamRequests.at(-1);
        assert.equal(sent.headers.authorization, `Bearer ${factoryKey}`);
        assert.equal(sent.headers['x-factory-org-id'], orgId);
        assert.ok(!JSON.stringify(sent.headers).includes(clientToken));
        assert.ok(!JSON.stringify(sent.headers).includes('client-spoofed-org'));
      }
    }
    assert.equal(getApiKey(), `Bearer ${factoryKey}`);
    assert.equal(getOrgId(), orgId);
  });

  await t.test('absent organization is not replaced by client organization', async () => {
    process.env.FACTORY_ORG_ID = '';
    initializeAuth();
    const res = await request(base, '/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${clientToken}`,
        'content-type': 'application/json', 'x-factory-org-id': 'spoofed-org' },
      body: JSON.stringify({ model: 'test-openai', input: [] })
    });
    assert.equal(res.status, 200);
    assert.equal(upstreamRequests.at(-1).headers['x-factory-org-id'], undefined);
  });

  await t.test('debug header logging redacts credentials', () => {
    const output = [];
    const original = console.log;
    config.dev_mode = true;
    console.log = (...args) => output.push(args.join(' '));
    try {
      const headers = { Authorization: `Bearer ${factoryKey}`, 'X-API-Key': clientToken };
      logRequest('POST', '/test', headers);
      logResponse(200, headers);
      assert.ok(!output.join('').includes(factoryKey));
      assert.ok(!output.join('').includes(clientToken));
      assert.match(output.join(''), /REDACTED/);
      assert.equal(headers['X-API-Key'], clientToken);
    } finally {
      console.log = original;
      config.dev_mode = false;
    }
  });

  await t.test('empty or invalid configuration fails closed', async () => {
    for (const value of ['', '   ', 'token with spaces', 'token,token']) {
      process.env.request_auth_token = value;
      assert.throws(() => initializeAuth(), /request_auth_token/);
      assert.equal((await request(base, '/v1/models', {
        headers: { authorization: `Bearer ${clientToken}` }
      })).status, 503);
    }
    process.env.request_auth_token = clientToken;
    process.env.FACTORY_API_KEY = '';
    assert.throws(() => initializeAuth(), /FACTORY_API_KEY/);
  });
});

test('.env is loaded before initialization and environment variables take precedence', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'droid2api-auth-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('droid2api-auth-'));
    return rm(dir, { recursive: true, force: true });
  });
  for (const file of ['auth.js', 'logger.js', 'config.js', 'config.json', 'user-agent-updater.js']) {
    await copyFile(new URL(file, import.meta.url), path.join(dir, file));
  }
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(dir, '.env'), '# test fixture\nFACTORY_API_KEY=fk-from-env-file\nFACTORY_ORG_ID=org-from-env-file\nrequest_auth_token="from-env-file"\n');
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (['factory_api_key', 'factory_org_id', 'request_auth_token'].includes(name.toLowerCase())) delete env[name];
  }
  const script = `
    import assert from 'node:assert/strict';
    import { initializeAuth, getApiKey, getOrgId } from './auth.js';
    initializeAuth();
    assert.equal(getApiKey(), 'Bearer fk-from-env-file');
    assert.equal(getOrgId(), 'org-from-env-file');
    assert.equal(process.env.request_auth_token, process.env.EXPECTED_TOKEN);
  `;
  for (const overrides of [
    { EXPECTED_TOKEN: 'from-env-file' },
    { EXPECTED_TOKEN: 'from-process-env', request_auth_token: 'from-process-env' }
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000
    });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const line of ['', 'request_auth_token=\n', 'request_auth_token="  "\n']) {
    await writeFile(path.join(dir, '.env'), `FACTORY_API_KEY=fk-test\n${line}`);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { initializeAuth } from './auth.js'; initializeAuth();"], {
      cwd: dir, env, encoding: 'utf8', timeout: 10000
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /request_auth_token environment variable is required/);
  }
});

test('real server exits before listening or background work when the client token is missing', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('server.js', import.meta.url))], {
    env: { ...process.env, FACTORY_API_KEY: factoryKey, request_auth_token: '' },
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /request_auth_token environment variable is required/);
  assert.doesNotMatch(result.stdout, /Starting server|User-Agent updater initialized/);
});
