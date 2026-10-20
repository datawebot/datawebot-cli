import { CliError } from './errors.js';

const pending = new Set(['PENDING', 'INITIATED']);
const terminal = new Set(['COMPLETED', 'PARTIAL_COMPLETE', 'FAILED', 'UNAVAILABLE']);

export function job(data, expectedId) {
  if (!data || typeof data.job_id !== 'string' || !/^[a-f0-9-]{36}$/.test(data.job_id) ||
      (expectedId && data.job_id !== expectedId) || (!pending.has(data.status) && !terminal.has(data.status))) {
    throw new CliError('invalid_response', 'API returned invalid Job metadata or a mismatched Job ID.');
  }
  return data;
}

export function outcome(data) {
  return data.status === 'PARTIAL_COMPLETE' ? 2 : ['FAILED', 'UNAVAILABLE'].includes(data.status) ? 1 : 0;
}

export async function waitForJob(client, response, key) {
  const id = job(response.data).job_id;
  let polls = 0;
  while (pending.has(response.data.status)) {
    const current = job(response.data, id);
    const eta = current.eta_delivery === null ? 0 : Date.parse(current.eta_delivery) - Date.now();
    const guidance = (current.poll_after_seconds ?? 2) * 1000;
    if (!Number.isFinite(eta) || !Number.isFinite(guidance) || guidance < 0) {
      throw new CliError('invalid_response', 'API returned invalid polling guidance.');
    }
    const delay = Math.max(2000, eta, guidance, response.retryAfter);
    client.log('poll: ' + (++polls) + ' in ' + Math.ceil(delay / 1000) + 's (' + current.status + ')');
    await client.wait(delay);
    response = await client.request('/v1/jobs/' + encodeURIComponent(id), { key });
    job(response.data, id);
  }
  client.log('result ready: ' + response.data.status);
  return response.data;
}

export async function results(client, id, key, { cursor, pageSize = 100 } = {}) {
  const query = new URLSearchParams({ page_size: String(pageSize) });
  if (cursor !== undefined) query.set('cursor', cursor);
  const { data } = await client.request('/v1/jobs/' + encodeURIComponent(id) + '/results?' + query, { key });
  job(data, id);
  if (terminal.has(data.status) && data.status !== 'UNAVAILABLE' &&
      (!Array.isArray(data.results) || !Array.isArray(data.errors) ||
       (data.next_cursor !== null && typeof data.next_cursor !== 'string'))) {
    throw new CliError('invalid_response', 'API returned an invalid result page.');
  }
  return data;
}

export function target(blueprint, input) {
  const aliases = { 'amazon.pdp': 'amazon.product_details', 'amazon.search': 'amazon.search_items' };
  const id = aliases[blueprint] ?? blueprint;
  let url = input;
  if (id === 'amazon.product_details' && /^[A-Z0-9]{10}$/.test(input)) {
    url = 'https://www.amazon.com/dp/' + input;
  } else if (id === 'amazon.search_items' && !/^https?:/i.test(input)) {
    const search = new URL('https://www.amazon.com/s');
    search.searchParams.set('k', input);
    url = search.href;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
  } catch { throw new CliError('invalid_target', 'Use an HTTPS source URL, or an Amazon ASIN/search keyword.'); }
  return { id, url };
}
