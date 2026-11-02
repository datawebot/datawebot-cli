import { CliError } from './errors.js';

// Request router (POST /v1/requests): ask by intent (search, product); the API picks and runs the Jobs.
const statuses = new Set(['working', 'done', 'failed']);

export function requestAnswer(data, expectedId) {
  if (!data || typeof data.request_id !== 'string' || !/^[a-f0-9-]{36}$/.test(data.request_id) ||
      (expectedId && data.request_id !== expectedId) || !statuses.has(data.status)) {
    throw new CliError('invalid_response', 'API returned an invalid request answer or a mismatched request ID.');
  }
  return data;
}

export function requestOutcome(data) {
  return data.status === 'failed' ? 1 : 0;
}

export async function waitForRequest(client, response, key) {
  const id = requestAnswer(response.data).request_id;
  let polls = 0;
  while (response.data.status === 'working') {
    const guidance = (response.data.check_after_seconds ?? 5) * 1000;
    if (!Number.isFinite(guidance) || guidance < 0) throw new CliError('invalid_response', 'API returned invalid polling guidance.');
    const delay = Math.max(2000, guidance, response.retryAfter);
    client.log('poll: ' + (++polls) + ' in ' + Math.ceil(delay / 1000) + 's (working)');
    await client.wait(delay);
    response = await client.request('/v1/requests/' + encodeURIComponent(id), { key });
    requestAnswer(response.data, id);
  }
  client.log('answer ready: ' + response.data.status);
  return response.data;
}
