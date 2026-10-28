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
import { requestAnswer, requestOutcome, waitForRequest } from './requests.js';

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
const requestId = value => {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new InvalidArgumentError('Expected a request_id UUID.');
  return value;
};
const country = value => {
  if (!/^[A-Za-z]{2}$/.test(value)) throw new InvalidArgumentError('Expected a two-letter market code, e.g. US, DE.');
  return value.toUpperCase();
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
    .description('Discover contracts across all supported stores. Search by store/domain/operation; use --blueprint-id for one exact contract.')
    .option('--blueprint-id <id>', 'exact registered operation ID')
    .option('--cursor <cursor>', 'next_cursor from discovery (keep the same search)')
    .option('--page-size <count>', 'contracts per page', integer(1, 100), 30)
    .action(async (query, opts) => {
      if (opts.blueprintId && (query !== undefined || opts.cursor !== undefined))
        throw new CliError('invalid_input', 'Use --blueprint-id separately from query and cursor.');
      const key = await client.token();
      const params = new URLSearchParams({ page_size: String(opts.pageSize) });
      if (query !== undefined) params.set('q', query);
      if (opts.blueprintId !== undefined) params.set('blueprint_id', opts.blueprintId);
      if (opts.cursor !== undefined) params.set('cursor', opts.cursor);
      const { data } = await client.request('/v1/job-blueprints?' + params, { key });
      if (!Array.isArray(data?.blueprints) || !Number.isSafeInteger(data.total) || data.total < 0 ||
          (data.next_cursor !== null && typeof data.next_cursor !== 'string'))
        throw new CliError('invalid_response', 'API did not return a paginated discovery response. Update the Jobs API before using this CLI.');
      output({ blueprints: data.blueprints, total: data.total, next_cursor: data.next_cursor });
    });
  program.command('credits').alias('account').description('Return this account’s credits (GET /v1/account) unchanged.')
    .action(async () => { output((await client.request('/v1/account', { key: await client.token() })).data); });
  // Ask by intent through the request router: the API picks the shop endpoint (or a shopping search) and runs it.
  const ask = async (body, opts) => {
    const key = await client.token();
    const requestKey = opts.requestKey ?? randomUUID();
    context = { request_key: requestKey };
    client.important('request_key: ' + requestKey);
    const accepted = await client.request('/v1/requests', { key, body: {
      ...body, format: opts.raw ? 'raw' : 'structured', request_key: requestKey,
      ...(opts.maxCredits === undefined ? {} : { max_credits: opts.maxCredits }) } });
    const answer = requestAnswer(accepted.data);
    context.request_id = answer.request_id;
    context.resume = 'dtwb result ' + answer.request_id + ' --wait (use the same API/issuer configuration)';
    client.important('request_id: ' + answer.request_id);
    const data = opts.async ? answer : await waitForRequest(client, accepted, key);
    output(data);
    exitCode = requestOutcome(data);
  };
  const askOptions = command => command
    .option('--max-credits <credits>', 'budget: if the request could cost more, nothing runs and nothing is charged', integer(0, 1000000))
    .option('--request-key <key>', 'the same key returns the same request instead of running it again (scripts: date plus run)', idempotency)
    .option('--raw', "also return the shop's own data unchanged, where the shop has it")
    .option('--async', 'return the first answer immediately; finish later with dtwb result');
  askOptions(program.command('search <query>')
    .description('Find products for a keyword, on one shop (--site) or across shops. Structured JSON with a product_id per result.')
    .option('--site <shop>', 'shop domain (allbirds.com, amazon.de) or name (allbirds); leave out to search across shops')
    .option('--country <code>', 'two-letter market code; picks the shop’s market when --site is a name', country, 'US')
    .option('--limit <count>', 'organic results to return', integer(1, 20), 10))
    .action(async (query, opts) => {
      const trimmed = query.trim();
      if (trimmed.length < 2 || trimmed.length > 200) throw new CliError('invalid_input', 'Search for 2–200 characters.');
      await ask({ capability: 'search', query: trimmed, country: opts.country, limit: opts.limit,
        ...(opts.site === undefined ? {} : { site: opts.site }) }, opts);
    });
  askOptions(program.command('product <url-or-product-id>')
    .description('One product’s details: by its page URL, or by a product_id from dtwb search.'))
    .action(async (value, opts) => {
      if (/^https:\/\//i.test(value)) await ask({ capability: 'product', url: target('product', value).url }, opts);
      else if (/^[A-Za-z0-9_-]{2,4096}$/.test(value)) await ask({ capability: 'product', product_id: value }, opts);
      else throw new CliError('invalid_target', 'Use an HTTPS product URL or a product_id from dtwb search.');
    });
  program.command('result <request-id>')
    .description('Read a search/product request again: finish one that answered "working", or read its next page. Free; never submits work.')
    .option('--wait', 'poll while the request is working; never resubmit')
    .option('--cursor <cursor>', 'next_cursor from the previous answer')
    .action(async (id, opts) => {
      requestId(id);
      context = { request_id: id, resume: 'dtwb result ' + id + ' --wait (use the same API/issuer configuration)' };
      const key = await client.token();
      const query = opts.cursor === undefined ? '' : '?' + new URLSearchParams({ cursor: opts.cursor });
      const response = await client.request('/v1/requests/' + encodeURIComponent(id) + query, { key });
      requestAnswer(response.data, id);
      const data = opts.wait ? await waitForRequest(client, response, key) : response.data;
      output(data);
      exitCode = requestOutcome(data);
    });
  program.command('site <shop>')
    .description('What datawebot can do on a shop (search, product details, catalogue) and the most each costs in credits. Free; runs nothing.')
    .option('--country <code>', 'two-letter market code; picks the shop’s market when <shop> is a name', country, 'US')
    .action(async (shop, opts) => {
      if (shop.length < 2 || shop.length > 253) throw new CliError('invalid_input', 'Give a shop domain or name.');
      const { data } = await client.request('/v1/sites?' + new URLSearchParams({ site: shop, country: opts.country }), { key: await client.token() });
      if (!data || typeof data.site !== 'string' || !['search', 'product', 'catalog'].every(k => typeof data[k]?.available === 'boolean'))
        throw new CliError('invalid_response', 'API did not return a site summary. Update the Jobs API before using this command.');
      output(data);
    });
  program.command('extract <blueprint> <input>')
    .description('Submit a blueprint and wait for one API result page. Amazon aliases: amazon.pdp ASIN, amazon.search keyword.')
    .option('--async', 'return the submission response immediately without polling')
    .option('--parameters <json>', 'blueprint parameters as a JSON object', parameters, {})
    .option('--idempotency-key <key>', 'reuse this key and identical inputs after an ambiguous submission', idempotency)
    .action(async (blueprint, input, opts) => {
      const { id, url } = target(blueprint, input);
      const key = await client.token();
      const { data: catalog } = await client.request('/v1/job-blueprints?' + new URLSearchParams({ blueprint_id: id }), { key });
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
  program.command('jobs').description('List this account’s active and past Jobs, newest first; return one unchanged API page.')
    .option('--cursor <cursor>', 'opaque next_cursor from the previous Jobs page')
    .option('--page-size <count>', 'Jobs per page', integer(1, 100), 25)
    .action(async opts => {
      const key = await client.token();
      const query = new URLSearchParams({ page_size: String(opts.pageSize) });
      if (opts.cursor !== undefined) query.set('cursor', opts.cursor);
      const { data } = await client.request('/v1/jobs?' + query, { key });
      if (!Array.isArray(data?.jobs) ||
          (data.next_cursor !== null && typeof data.next_cursor !== 'string')) {
        throw new CliError('invalid_response', 'API returned an invalid Jobs page.');
      }
      for (const listed of data.jobs) job(listed);
      output(data);
    });
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
