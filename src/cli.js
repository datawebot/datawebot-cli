import { Command, InvalidArgumentError } from 'commander';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, API_URL, AUTH_URL } from './client.js';
import { Credentials } from './credentials.js';
import { CliError } from './errors.js';
import { register } from './register.js';
import { job, outcome, results, target, waitForJob } from './jobs.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const integer = (min, max) => value => {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < min || number > max) {
    throw new InvalidArgumentError('Expected an integer from ' + min + ' to ' + max + '.');
  }
  return number;
};
const parameters = value => {
  try {
    const data = JSON.parse(value);
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch { throw new InvalidArgumentError('Parameters must be a JSON object.'); }
};
const jobId = value => {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new InvalidArgumentError('Expected a Job UUID.');
  return value;
};
const idempotency = value => {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new InvalidArgumentError('Use 8–128 letters, numbers, underscores or hyphens.');
  return value;
};

export async function run(args, { env = process.env, stdout = process.stdout, stderr = process.stderr,
    signal, fetchImpl = fetch, store } = {}) {
  let client;
  let context = {};
  let exitCode = 0;
  const output = data => stdout.write(JSON.stringify(data) + '\n');
  const program = new Command().name('dtwb').version(version)
    .description('datawebot data extraction for humans and AI agents. JSON on stdout; progress/errors on stderr.')
    .option('--api-url <origin>', 'Jobs API origin', env.DATAWEBOT_API_URL || API_URL)
    .option('--auth-url <origin>', 'API-key issuer origin', env.DATAWEBOT_AUTH_URL || AUTH_URL)
    .option('--timeout <seconds>', 'total waiting budget (seconds)', integer(1, 86400), 600)
    .option('-v, --verbose', 'include HTTP retry details')
    .option('-q, --quiet', 'suppress routine progress (recovery details remain)')
    .configureOutput({ writeOut: text => stdout.write(text), writeErr: () => {}, outputError: () => {} })
    .exitOverride();
  program.hook('preAction', () => {
    const opts = program.opts();
    const log = (text, important = false) => {
      if (important || !opts.quiet) stderr.write(String(text).replace(/[\u0000-\u001f\u007f]/g, ' ') + '\n');
    };
    client = new Client({ apiUrl: opts.apiUrl, authUrl: opts.authUrl, timeout: opts.timeout, signal,
      store: store ?? new Credentials(env.DATAWEBOT_CONFIG_DIR || join(homedir(), '.datawebot')),
      apiKey: env.DATAWEBOT_API_KEY, fetchImpl,
      log: (text, detail = false) => { if (!detail || opts.verbose) log(text); },
    });
    // Approval/recovery instructions must remain visible even with --quiet.
    client.important = text => log(text, true);
  });
  program.command('register [email]').alias('login')
    .description('Sign in/register by email approval and save an API key; resume an interrupted approval without another email.')
    .action(async email => {
      const log = client.log;
      client.log = client.important;
      try { output(await register(client, email)); }
      finally { client.log = log; }
    });
  program.command('discover [query]').alias('man')
    .description('Discover live blueprint input/record schemas. Optional query filters blueprint IDs, names and descriptions.')
    .action(async query => {
      const key = await client.token();
      const { data } = await client.request('/v1/job-blueprints', { key });
      if (!Array.isArray(data?.blueprints)) throw new CliError('invalid_response', 'API did not return a blueprint catalog.');
      output(query ? { ...data, blueprints: data.blueprints.filter(b =>
        [b.blueprint_id, b.name, b.description].some(value => String(value).toLowerCase().includes(query.toLowerCase()))) } : data);
    });
  program.command('credits').alias('account').description('Return the Jobs account/credit response unchanged (currently synthetic/unbilled).')
    .action(async () => { output((await client.request('/v1/account', { key: await client.token() })).data); });
  program.command('extract <blueprint> <input>')
    .description('Submit a blueprint and wait for one API result page. Amazon aliases: amazon.pdp ASIN, amazon.search keyword.')
    .option('--async', 'return the submission response immediately without polling')
    .option('--parameters <json>', 'blueprint parameters as a JSON object', parameters, {})
    .option('--idempotency-key <key>', 'reuse this key and identical inputs after an ambiguous submission', idempotency)
    .action(async (blueprint, input, opts) => {
      const { id, url } = target(blueprint, input);
      const key = await client.token();
      const { data: catalog } = await client.request('/v1/job-blueprints', { key });
      const contract = catalog?.blueprints?.find(b => b.blueprint_id === id);
      if (!contract || typeof contract.version !== 'string') throw new CliError('unknown_blueprint', 'Blueprint not in the live catalog. Run dtwb discover.');
      const idempotencyKey = opts.idempotencyKey ?? randomUUID();
      context = { idempotency_key: idempotencyKey };
      client.log('preparing ' + id);
      client.important('idempotency_key: ' + idempotencyKey);
      const accepted = await client.request('/v1/jobs', { key, idempotencyKey,
        body: { blueprint_id: id, blueprint_version: contract.version, url, parameters: opts.parameters },
      });
      const submitted = job(accepted.data);
      context.job_id = submitted.job_id;
      context.resume = 'dtwb retrieve ' + submitted.job_id + ' --wait (use the same API/issuer configuration)';
      client.important('job_id: ' + submitted.job_id);
      if (opts.async) { output(submitted); exitCode = outcome(submitted); return; }
      const finished = await waitForJob(client, accepted, key);
      const data = finished.status === 'UNAVAILABLE' ? finished : await results(client, submitted.job_id, key);
      output(data);
      exitCode = outcome(data);
    });
  program.command('status <job-id>').description('Read Job metadata once; never submit new work.')
    .action(async id => {
      jobId(id);
      const { data } = await client.request('/v1/jobs/' + encodeURIComponent(id), { key: await client.token() });
      output(job(data, id));
    });
  program.command('retrieve <job-id>')
    .description('Retrieve one unchanged API result page, or pending metadata. Use next_cursor for further pages.')
    .option('--wait', 'poll until terminal before retrieving; never resubmit')
    .option('--cursor <cursor>', 'opaque next_cursor from the previous result page')
    .option('--page-size <count>', 'records per result page', integer(1, 100), 100)
    .action(async (id, opts) => {
      jobId(id);
      context = { job_id: id, resume: 'dtwb retrieve ' + id + ' --wait (use the same API/issuer configuration)' };
      const key = await client.token();
      if (opts.wait) {
        const response = await client.request('/v1/jobs/' + encodeURIComponent(id), { key });
        job(response.data, id);
        const finished = await waitForJob(client, response, key);
        if (finished.status === 'UNAVAILABLE') { output(finished); exitCode = 1; return; }
      }
      const data = await results(client, id, key, opts);
      output(data);
      exitCode = outcome(data);
    });
  program.command('jobs').description('Account-wide Job listing: blocked until the Jobs API exposes a list endpoint.')
    .action(() => { throw new CliError('not_supported', 'The current Jobs API has no account-wide job-list endpoint. Retain job_id and use dtwb status/retrieve.'); });
  try {
    if (!args.length) { program.outputHelp(); return 0; }
    await program.parseAsync(args, { from: 'user' });
    return exitCode;
  } catch (error) {
    if (['commander.help', 'commander.helpDisplayed', 'commander.version'].includes(error.code)) return 0;
    const redact = value => client ? client.redact(value) : String(value).split(env.DATAWEBOT_API_KEY || '\0').join('[REDACTED]');
    const payload = { error: { code: error.code ?? 'cli_error', message: error instanceof CliError || error.code?.startsWith('commander.')
      ? error.message : 'Local operation failed; check file permissions and configuration.', ...error.details, ...context } };
    stderr.write(redact(JSON.stringify(payload)) + '\n');
    return error.code?.startsWith('commander.') || error instanceof InvalidArgumentError ? 2 : 1;
  }
}
