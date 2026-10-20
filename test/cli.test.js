import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/cli.js';
import { Credentials } from '../src/credentials.js';
import { Client, API_URL, AUTH_URL, origin } from '../src/client.js';
import { register } from '../src/register.js';
import { CliError } from '../src/errors.js';

const KEY = 'dwb_' + 'a'.repeat(64);
const ID = '11111111-1111-4111-8111-111111111111';
const catalog = { blueprints: [
  { blueprint_id: 'amazon.search_items', version: '1', name: 'Amazon search', description: 'Search', availability: 'ENABLED' },
  { blueprint_id: 'amazon.product_details', version: '1', name: 'Amazon PDP', description: 'One product', availability: 'ENABLED' },
  { blueprint_id: 'newshop.search_items', version: '2', name: 'New shop', description: 'Dynamic blueprint', availability: 'ENABLED' },
], billing: 'mock_unbilled' };
const metadata = (status = 'PENDING') => ({ job_id: ID, status, eta_delivery: status === 'PENDING' ? new Date().toISOString() : null,
  poll_after_seconds: status === 'PENDING' ? 2 : null, request: { original: true }, result_count: 1 });
const page = (status = 'COMPLETED', cursor = null) => ({ ...metadata(status), results: [{ record_index: 0, data: { title: 'Coffee' } }],
  errors: status === 'PARTIAL_COMPLETE' ? [{ code: 'source_failed', message: 'One page failed' }] : [], next_cursor: cursor });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

function runner(steps, extra = {}) {
  let stdout = '', stderr = '';
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = { url: new URL(url), ...options, body: options.body === undefined ? undefined : JSON.parse(options.body) };
    calls.push(request);
    assert.equal(options.redirect, 'error');
    const step = steps.shift();
    assert(step, 'Unexpected request: ' + request.url.pathname);
    return typeof step === 'function' ? await step(request) : step;
  };
  return {
    calls, steps,
    invoke: async args => {
      const code = await run(args, { env: { DATAWEBOT_API_KEY: KEY }, stdout: { write: text => { stdout += text; } },
        stderr: { write: text => { stderr += text; } }, fetchImpl, ...extra });
      return { code, stdout, stderr };
    },
  };
}

async function storeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dtwb-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new Credentials(directory);
}

function authClient(store, steps) {
  const messages = [];
  const client = new Client({ apiUrl: API_URL, authUrl: AUTH_URL, timeout: 600, store,
    log: text => messages.push(text), fetchImpl: async (url, options) => {
      const step = steps.shift();
      assert(step, 'Unexpected auth request');
      return typeof step === 'function' ? step({ url: new URL(url), ...options, body: JSON.parse(options.body) }) : step;
    },
  });
  client.waits = [];
  client.wait = async ms => { client.waits.push(ms); };
  return { client, messages };
}

const signedIn = () => json({ result: { structuredContent: { data: { signed_in: true, account_email: 'person@example.com' } } } });
const challenge = { device_code: 'b'.repeat(64), user_code: 'BCDF-GHJK', verification_uri: 'https://www.datawebot.com/device', expires_in: 600, interval: 5 };

test('help/version need neither credentials nor network; parser errors are JSON on stderr', async () => {
  const store = { read() { throw new Error('Must not read credentials'); } };
  for (const args of [[], ['--help'], ['--version'], ['help', 'extract']]) {
    const result = await runner([], { store }).invoke(args);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert(result.stdout.length > 0);
  }
  for (const args of [['wrong-command'], ['extract'], ['--timeout', '0', 'credits'], ['extract', 'amazon.pdp', 'B012345678', '--parameters', '[]']]) {
    const result = await runner([], { store }).invoke(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error.code, /^commander\./);
  }
});

test('discovery is unchanged without query; query/man filter only the blueprints', async () => {
  const whole = await runner([json(catalog)]).invoke(['discover']);
  assert.deepEqual(JSON.parse(whole.stdout), catalog);
  const filtered = await runner([json(catalog)]).invoke(['man', 'AMAZON']);
  assert.equal(JSON.parse(filtered.stdout).blueprints.length, 2);
  assert.equal(JSON.parse(filtered.stdout).billing, 'mock_unbilled');
});

test('credits exposes synthetic account flags unchanged', async () => {
  const account = { credits: 100000, credits_kind: 'synthetic', credit_debits_enabled: false, billing: 'mock_unbilled' };
  const cli = runner([request => {
    assert.equal(request.url.pathname, '/v1/account');
    assert.equal(request.headers.Authorization, 'Bearer ' + KEY);
    return json(account);
  }]);
  const result = await cli.invoke(['credits']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), account);
});

test('async extraction resolves aliases and returns exact acceptance without polling', async () => {
  const accepted = metadata();
  const cli = runner([json(catalog), request => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url.pathname, '/v1/jobs');
    assert.equal(request.headers['Idempotency-Key'], 'same-key-123');
    assert.deepEqual(request.body, { blueprint_id: 'amazon.search_items', blueprint_version: '1',
      url: 'https://www.amazon.com/s?k=coffee+beans', parameters: { max_pages: 2 } });
    return json(accepted, 202);
  }]);
  const result = await cli.invoke(['extract', '--async', 'amazon.search', 'coffee beans', '--parameters', '{"max_pages":2}', '--idempotency-key', 'same-key-123']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), accepted);
  assert.equal(cli.calls.length, 2);
  assert.match(result.stderr, /job_id:/);
  assert(!result.stderr.includes(KEY));
});

test('PDP ASIN shorthand and dynamically discovered versions work', async () => {
  for (const [blueprint, input, expectedId, version, url] of [
    ['amazon.pdp', 'B012345678', 'amazon.product_details', '1', 'https://www.amazon.com/dp/B012345678'],
    ['newshop.search_items', 'https://shop.example/catalog', 'newshop.search_items', '2', 'https://shop.example/catalog'],
  ]) {
    const cli = runner([json(catalog), request => {
      assert.equal(request.body.blueprint_id, expectedId);
      assert.equal(request.body.blueprint_version, version);
      assert.equal(request.body.url, url);
      return json(metadata(), 202);
    }]);
    assert.equal((await cli.invoke(['extract', '--async', blueprint, input])).code, 0);
  }
});

test('extract waits, polls read-only and returns an unchanged first result page with cursor', async () => {
  const resultPage = page('COMPLETED', 'opaque-cursor');
  const cli = runner([json(catalog), json(metadata(), 202), request => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url.pathname, '/v1/jobs/' + ID);
    return json(metadata('COMPLETED'));
  }, request => {
    assert.equal(request.url.pathname, '/v1/jobs/' + ID + '/results');
    return json(resultPage);
  }]);
  const result = await cli.invoke(['extract', 'amazon.pdp', 'B012345678']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), resultPage);
  assert.match(result.stderr, /poll: 1/);
  assert.equal(cli.steps.length, 0);
});

test('pending retrieve is one-shot; cursor/page-size are forwarded safely', async () => {
  const pending = metadata();
  const once = runner([json(pending)]);
  assert.deepEqual(JSON.parse((await once.invoke(['retrieve', ID])).stdout), pending);
  assert.equal(once.calls.length, 1);
  const cli = runner([request => {
    assert.equal(request.url.searchParams.get('cursor'), 'opaque+/=&token');
    assert.equal(request.url.searchParams.get('page_size'), '37');
    return json(page());
  }]);
  assert.equal((await cli.invoke(['retrieve', ID, '--cursor', 'opaque+/=&token', '--page-size', '37'])).code, 0);
});

test('failed/partial/unavailable outcomes are preserved and never resubmitted', async () => {
  for (const [status, code] of [['FAILED', 1], ['PARTIAL_COMPLETE', 2], ['UNAVAILABLE', 1]]) {
    const cli = runner([json(status === 'UNAVAILABLE' ? metadata(status) : page(status))]);
    const result = await cli.invoke(['retrieve', ID]);
    assert.equal(result.code, code);
    assert.equal(JSON.parse(result.stdout).status, status);
    assert.equal(cli.calls.length, 1);
  }
  const cli = runner([json(catalog), json(metadata('UNAVAILABLE'), 202)]);
  const result = await cli.invoke(['extract', 'amazon.pdp', 'B012345678']);
  assert.equal(result.code, 1);
  assert.equal(cli.calls.length, 2);
});

test('ambiguous submission has no automatic retry and retains idempotency key', async () => {
  const cli = runner([json(catalog), () => { throw new Error('Network error ' + KEY); }]);
  const result = await cli.invoke(['extract', '--async', 'amazon.search', 'coffee', '--idempotency-key', 'retained-key-1']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr.trim().split('\n').at(-1)).error;
  assert.equal(error.idempotency_key, 'retained-key-1');
  assert.equal(error.code, 'network_error');
  assert.equal(cli.calls.length, 2);
  assert(!result.stderr.includes(KEY));
});

test('timeout after acceptance retains Job ID/resume details and does not cancel', async () => {
  const cli = runner([json(catalog), json(metadata(), 202)]);
  const result = await cli.invoke(['--timeout', '1', 'extract', 'amazon.pdp', 'B012345678']);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stderr.trim().split('\n').at(-1)).error;
  assert.equal(error.code, 'timeout');
  assert.equal(error.job_id, ID);
  assert.match(error.resume, /retrieve/);
  assert.equal(cli.calls.length, 2);
});

test('malformed/mismatched responses fail closed; raw API errors redact keys', async () => {
  for (const response of [new Response('<html>bad</html>'), json({ ...page(), job_id: '22222222-2222-4222-8222-222222222222' })]) {
    const result = await runner([response]).invoke(['retrieve', ID]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'invalid_response');
  }
  const result = await runner([json({ error: { code: 'denied', message: 'Do not echo ' + KEY } }, 403)]).invoke(['credits']);
  assert.equal(result.code, 1);
  assert(!result.stderr.includes(KEY));
  assert.match(result.stderr, /REDACTED/);
});

test('job listing explicitly reports missing API dependency without network', async () => {
  const result = await runner([]).invoke(['jobs']);
  assert.equal(JSON.parse(result.stderr).error.code, 'not_supported');
});

test('origins, parameters and target security checks reject unsafe input before submission', async () => {
  for (const value of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com/v1', 'https://example.com/?q=x']) {
    assert.throws(() => origin(value), /HTTPS origin/);
  }
  assert.equal(origin('http://127.0.0.1:8792'), 'http://127.0.0.1:8792');
  for (const args of [['extract', 'amazon.pdp', 'http://example.com'], ['retrieve', 'invalid-id']]) {
    const cli = runner([]);
    assert.notEqual((await cli.invoke(args)).code, 0);
    assert.equal(cli.calls.length, 0);
  }
});

test('GET transient retry honors Retry-After; POST never retries automatically', async () => {
  const { client } = authClient({}, []);
  const replies = [json({ error: 'busy' }, 429, { 'Retry-After': '3' }), json({ ok: true })];
  client.fetch = async () => replies.shift();
  assert.deepEqual((await client.request('/v1/account')).data, { ok: true });
  assert.deepEqual(client.waits, [3000]);
  let posts = 0;
  client.fetch = async () => { posts++; return json({ error: 'busy' }, 503); };
  await assert.rejects(client.request('/v1/jobs', { body: {} }), error => error.code === 'busy');
  assert.equal(posts, 1);
});

test('real loopback HTTP transport preserves Authorization and account JSON', async t => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/account');
    assert.equal(request.headers.authorization, 'Bearer ' + KEY);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ credits: 100000, credits_kind: 'synthetic' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let stdout = '', stderr = '';
  const code = await run(['--api-url', 'http://127.0.0.1:' + server.address().port, 'credits'], {
    env: { DATAWEBOT_API_KEY: KEY }, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
  });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).credits_kind, 'synthetic');
});

test('device approval handles pending/slow_down, preserves other profiles, and never logs secrets', async t => {
  const store = await storeFixture(t);
  await store.write('credentials', { version: 1, profiles: { 'https://other.example': { api_key: 'untouched' } } });
  const steps = [request => {
    assert.equal(request.url.pathname, '/v1/device/code');
    assert.equal(request.body.email, 'person@example.com');
    assert.equal(request.headers.Authorization, undefined);
    return json(challenge);
  }, json({ error: 'authorization_pending' }, 400), json({ error: 'slow_down' }, 400), request => {
    assert.equal(request.body.device_code, challenge.device_code);
    assert.equal(request.body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
    return json({ api_key: KEY, account_email: 'person@example.com' });
  }];
  const { client, messages } = authClient(store, steps);
  assert.deepEqual(await register(client, 'person@example.com'), { signed_in: true, account_email: 'person@example.com', reused: false });
  assert.deepEqual(client.waits, [5000, 5000, 10000]);
  const saved = await store.read('credentials');
  assert.equal(saved.profiles[AUTH_URL].api_key, KEY);
  assert.equal(saved.profiles['https://other.example'].api_key, 'untouched');
  assert.deepEqual(await store.read('device-pending.json'), {});
  assert(!messages.join().includes(KEY));
  assert(!messages.join().includes(challenge.device_code));
});

test('valid saved issuer key is reused; network/403 failures never send another email', async t => {
  const store = await storeFixture(t);
  await store.write('credentials', { version: 1, profiles: { [AUTH_URL]: { api_key: KEY } } });
  const { client } = authClient(store, [signedIn()]);
  assert.equal((await register(client)).reused, true);
  for (const response of [json({ error: 'denied' }, 403), () => { throw new Error('offline'); }]) {
    const steps = [response];
    const { client } = authClient(store, steps);
    await assert.rejects(register(client, 'person@example.com'));
    assert.equal(steps.length, 0);
    assert.equal((await store.read('credentials')).profiles[AUTH_URL].api_key, KEY);
  }
});

test('issuer 401 permits reauthentication; interrupted challenge resumes without email', async t => {
  const store = await storeFixture(t);
  await store.write('credentials', { version: 1, profiles: { [AUTH_URL]: { api_key: KEY } } });
  const identity = AUTH_URL + '|datawebot CLI|' + hostname();
  await store.write('device-pending.json', { [identity]: { code: challenge, email: 'person@example.com', deadline: Date.now() / 1000 + 600, api_url: API_URL } });
  const steps = [json({ error: 'login_required' }, 401), request => {
    assert.equal(request.url.pathname, '/v1/device/token');
    return json({ api_key: KEY, account_email: 'person@example.com' });
  }];
  const { client, messages } = authClient(store, steps);
  await register(client);
  assert.equal(steps.length, 0);
  assert.match(messages.join(), /Resuming/);
});

test('saved production keys cannot be silently sent to another API origin', async t => {
  const store = await storeFixture(t);
  await store.write('credentials', { version: 1, profiles: { [AUTH_URL]: { api_key: KEY } } });
  const client = new Client({ apiUrl: 'https://other.example', authUrl: AUTH_URL, timeout: 600, store });
  await assert.rejects(client.token(), error => error.code === 'credential_origin_mismatch');
  await assert.rejects(register(client), error => error.code === 'credential_origin_mismatch');
});

test('aborted waiting retains Job ID and never resubmits', async () => {
  const controller = new AbortController();
  const cli = runner([json(catalog), () => { controller.abort(); return json(metadata(), 202); }], { signal: controller.signal });
  const result = await cli.invoke(['extract', 'amazon.pdp', 'B012345678']);
  const error = JSON.parse(result.stderr.trim().split('\n').at(-1)).error;
  assert.equal(error.code, 'interrupted');
  assert.equal(error.job_id, ID);
  assert.equal(cli.calls.length, 2);
});

test('registration cannot silently reuse another account or pending email', async t => {
  const store = await storeFixture(t);
  await store.write('credentials', { version: 1, profiles: { [AUTH_URL]: { api_key: KEY } } });
  const saved = authClient(store, [signedIn()]);
  await assert.rejects(register(saved.client, 'other@example.com'), error => error.code === 'account_mismatch');
  await store.write('credentials', { version: 1, profiles: {} });
  await store.write('device-pending.json', { [AUTH_URL + '|datawebot CLI|' + hostname()]: {
    code: challenge, email: 'person@example.com', deadline: Date.now() / 1000 + 600,
  } });
  const pending = authClient(store, []);
  await assert.rejects(register(pending.client, 'other@example.com'), error => error.code === 'account_mismatch');
});

test('retrieve --wait rejects mismatched initial Job ID before any result access', async () => {
  const cli = runner([json({ ...metadata(), job_id: '22222222-2222-4222-8222-222222222222' })]);
  const result = await cli.invoke(['retrieve', ID, '--wait']);
  assert.equal(JSON.parse(result.stderr).error.code, 'invalid_response');
  assert.equal(cli.calls.length, 1);
});

test('issuer denial is terminal; pending challenge is retained and no key is saved', async t => {
  const store = await storeFixture(t);
  const { client } = authClient(store, [json(challenge), json({ error: 'access_denied' }, 400)]);
  await assert.rejects(register(client, 'person@example.com'), error => error instanceof CliError && error.code === 'access_denied');
  assert.deepEqual(await store.read('credentials'), {});
  assert.equal(Object.keys(await store.read('device-pending.json')).length, 1);
});
