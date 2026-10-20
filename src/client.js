import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from './errors.js';

export const API_URL = 'https://api.datawebot.com';
export const AUTH_URL = 'https://mcp.datawebot.com';

export function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new CliError('invalid_origin', 'Provide an HTTPS origin, or HTTP on loopback only.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new CliError('invalid_origin', 'Use an HTTPS origin without credentials/path/query, or HTTP on loopback only.');
  }
  return url.origin;
}

async function readJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new CliError('invalid_response', 'API returned an empty response.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw new CliError('invalid_response', 'API response exceeded 4 MiB.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CliError('invalid_response', 'API returned invalid JSON.'); }
  } finally { await reader.cancel().catch(() => {}); }
}

export class Client {
  constructor({ apiUrl, authUrl, store, apiKey, timeout, signal, log, fetchImpl = fetch }) {
    this.apiUrl = origin(apiUrl);
    this.authUrl = origin(authUrl);
    this.store = store;
    this.apiKey = apiKey;
    this.deadline = Date.now() + timeout * 1000;
    this.signal = signal;
    this.log = log;
    this.fetch = fetchImpl;
    this.secrets = new Set(apiKey ? [apiKey] : []);
  }

  redact(value) {
    let text = String(value).replace(/dwb_[a-f0-9]{64}/gi, '[REDACTED]');
    for (const secret of this.secrets) text = text.split(secret).join('[REDACTED]');
    return text;
  }

  remaining() {
    if (this.signal?.aborted) throw new CliError('interrupted', 'Stopped waiting; saved work is retained.');
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new CliError('timeout', 'Waiting budget expired; saved work may still be running.');
    return remaining;
  }

  async wait(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new CliError('invalid_response', 'API returned invalid polling guidance.');
    try { await sleep(Math.min(ms, this.remaining()), undefined, { signal: this.signal }); }
    catch { this.remaining(); throw new CliError('interrupted', 'Stopped waiting; saved work is retained.'); }
    this.remaining();
  }

  async token() {
    let key = this.apiKey;
    if (!key) {
      const saved = await this.store.read('credentials');
      const profile = saved.profiles?.[this.authUrl];
      const allowed = profile?.api_url ?? (this.authUrl === AUTH_URL ? API_URL : this.authUrl);
      if (profile?.api_key && allowed !== this.apiUrl) {
        throw new CliError('credential_origin_mismatch', 'Saved key belongs to a different API origin. Sign in for this API/issuer pair or supply DATAWEBOT_API_KEY explicitly.');
      }
      key = profile?.api_key;
    }
    if (typeof key !== 'string' || !key || /\s/.test(key)) {
      throw new CliError('login_required', 'Run dtwb register <email> or supply DATAWEBOT_API_KEY through your environment.');
    }
    this.secrets.add(key);
    return key;
  }

  async request(path, { body, key, auth = false, idempotencyKey, accept = 'application/json' } = {}) {
    const method = body === undefined ? 'GET' : 'POST';
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        const budget = this.remaining();
        response = await this.fetch((auth ? this.authUrl : this.apiUrl) + path, {
          method, redirect: 'error', signal: AbortSignal.any([
            AbortSignal.timeout(Math.min(30000, budget)), ...(this.signal ? [this.signal] : []),
          ]),
          headers: { Accept: accept, 'User-Agent': 'datawebot-cli',
            ...(key ? { Authorization: 'Bearer ' + key } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (error instanceof CliError) throw error;
        this.remaining();
        throw new CliError('network_error', 'Network/timeout error; request outcome may be unknown. No automatic submission retry.');
      }
      const header = response.headers.get('retry-after');
      const retryAfter = header === null ? 0 : (/^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now());
      const delay = Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0;
      if (method === 'GET' && [429, 502, 503, 504].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        this.log('HTTP ' + response.status + '; retrying read', true);
        await this.wait(Math.max(delay, 1000 * 2 ** attempt));
        continue;
      }
      let data;
      try { data = await readJSON(response); }
      catch (error) {
        if (error instanceof CliError) throw error;
        this.remaining();
        throw new CliError('network_error', 'Response interrupted; request outcome may be unknown.');
      }
      if (!response.ok) {
        const error = data?.error;
        throw new CliError(typeof error === 'string' ? error : error?.code ?? 'http_error',
          typeof error?.message === 'string' ? error.message : 'API returned HTTP ' + response.status + '.',
          { http_status: response.status, retry_after_ms: delay });
      }
      return { data, retryAfter: delay };
    }
  }

  async identity(key) {
    const { data } = await this.request('/mcp', { auth: true, key,
      accept: 'application/json, text/event-stream',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discover', arguments: {} } },
    });
    const identity = data?.result?.structuredContent?.data;
    if (data?.error || data?.result?.isError || !identity?.signed_in) {
      throw new CliError('invalid_response', 'Issuer could not confirm saved sign-in; no new approval email sent.');
    }
    return identity;
  }
}
