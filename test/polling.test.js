import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForJob } from '../src/jobs.js';

const ID = '11111111-1111-4111-8111-111111111111';
const finished = { job_id: ID, status: 'COMPLETED', eta_delivery: null };

test('polling honors the greatest of ETA, poll_after_seconds and Retry-After', async () => {
  for (const [guidance, retryAfter, minimum] of [[20, 1000, 20000], [2, 30000, 30000]]) {
    const waits = [];
    const client = { log() {}, wait: async ms => waits.push(ms), request: async (path, { key }) => {
      assert.equal(path, '/v1/jobs/' + ID);
      assert.equal(key, 'fixture-key');
      return { data: finished, retryAfter: 0 };
    } };
    assert.deepEqual(await waitForJob(client, { retryAfter, data: { job_id: ID, status: 'PENDING',
      eta_delivery: new Date(Date.now() + 10000).toISOString(), poll_after_seconds: guidance } }, 'fixture-key'), finished);
    assert.equal(waits[0], minimum);
  }
  const waits = [];
  const client = { log() {}, wait: async ms => waits.push(ms), request: async () => ({ data: finished, retryAfter: 0 }) };
  await waitForJob(client, { retryAfter: 0, data: { job_id: ID, status: 'INITIATED',
    eta_delivery: new Date(Date.now() + 60000).toISOString(), poll_after_seconds: 2 } }, 'fixture-key');
  assert(waits[0] >= 59000);
});

test('terminal Jobs do not poll and invalid metadata/guidance does not loop', async () => {
  const client = { log() {}, wait() { assert.fail('No wait expected'); }, request() { assert.fail('No request expected'); } };
  assert.deepEqual(await waitForJob(client, { data: finished, retryAfter: 0 }, 'fixture'), finished);
  for (const data of [
    { job_id: ID, status: 'NEW_UNKNOWN_STATUS' },
    { job_id: ID, status: 'PENDING', eta_delivery: 'not a timestamp' },
    { job_id: ID, status: 'PENDING', eta_delivery: null, poll_after_seconds: -2 },
  ]) {
    await assert.rejects(waitForJob(client, { data, retryAfter: 0 }, 'fixture'), error => error.code === 'invalid_response');
  }
});
