# datawebot CLI

Agent-friendly API wrapper for [datawebot](https://www.datawebot.com), built with
[Commander.js](https://github.com/tj/commander.js). Executable: **dtwb**.

**Initial 0.x preview.** Node **22.12+** is required. No build step. Source
availability and npm installation do not grant access to restricted blueprints.

## Install

Published on npm: [@datawebot/cli](https://www.npmjs.com/package/@datawebot/cli).

```sh
npm install --global @datawebot/cli@0.1.3
dtwb --version
dtwb --help
```

Or run without a global install:

```sh
npx --yes --package=@datawebot/cli@0.1.3 dtwb --help
```

## Develop / install locally

```sh
npm ci
npm test
npm link
# Or without a global link:
node bin/dtwb.js --help
```

## Sign in and discover

```sh
dtwb register you@example.com
dtwb discover
dtwb discover amazon
dtwb discover based.com
dtwb man --blueprint-id amazon.product_details
dtwb discover --page-size 30 --cursor 'NEXT_CURSOR_FROM_DISCOVERY'
dtwb credits
dtwb jobs
dtwb jobs --page-size 25 --cursor 'NEXT_CURSOR_FROM_PREVIOUS_JOBS_PAGE'
```

`jobs` lists this account’s active and past Jobs, newest first, returning one
unchanged API page. Use its `next_cursor` to continue; the CLI does not filter
statuses, combine pages, or substitute machine-local history. Listing uses
`GET /v1/jobs` with your customer key. Availability and access are determined by
the API; the CLI does not bypass permissions or maintenance.

Discovery searches all public stores through `GET /v1/job-blueprints?q=...`;
there is no separate Shopify catalog to select. It returns `blueprints`, `total`
and `next_cursor`, with full input/output contracts, current price and configured
availability. With no query it returns the first page (30 contracts by default,
maximum 100); keep the same query when following `next_cursor`. Use
`--blueprint-id` alone for one exact contract. IDs are opaque: use the ID returned
by discovery rather than constructing it. Registration does not prove a store's
extraction has passed production acceptance; follow the qualification caveat.

Registration uses the existing email-approved device flow. Compare the code in
stderr with your approval email, then approve on the website. Opening the email
alone does not approve. The command waits, saves the key privately, and returns
only a sign-in summary, **never the key**. It can also sign in an existing account
(`dtwb login`). Signup eligibility and Jobs eligibility remain server policy;
sign-in does not bypass private-preview/maintenance gates.

Interrupted approval requests are resumed without another email. Existing keys
are validated with the issuer and reused; only an explicit issuer 401 allows a
new approval request. A different requested email is rejected rather than silently
switching accounts; use a separate `DATAWEBOT_CONFIG_DIR` for another account.
If starting sign-in or collecting the one-time token has an
ambiguous network outcome, stop and inspect/retry the pending request, not a new
registration. Run one registration per config directory at a time.

The CLI shares the existing agent setup file, `~/.datawebot/credentials`, with
profiles indexed by issuer origin. Files must be owned regular files with mode
0600 in an owned directory with mode 0700; symlinks and unsafe permissions are
rejected. Writes replace files atomically. Pending device challenges are also
private. On Windows, POSIX mode checks are unavailable: protect this directory
with your account's filesystem ACLs. Disconnect/revoke keys on the website;
there is no pretend local-only server revocation command.

## Search and product (by intent)

```sh
# These examples submit real work and can use credits.
dtwb search 'running shoes' --site allbirds.com --limit 5
dtwb search 'running shoes' --site allbirds --country DE   # a shop name picks that market's shop
dtwb search 'espresso grinder'                              # across shops
dtwb product https://www.allbirds.com/products/mens-tree-runners
dtwb product PRODUCT_ID_FROM_SEARCH

# Budget and replay-safe keys for scheduled scripts:
dtwb search 'running shoes' --site allbirds.com --max-credits 10 --request-key nightly-2026-10-28

# Free: what a shop supports and the most each costs, before running anything.
dtwb site allbirds.com

# Free: finish a request that answered "working", or read its next page.
dtwb result REQUEST_ID --wait
dtwb result REQUEST_ID --cursor 'NEXT_CURSOR_FROM_PREVIOUS_ANSWER'
```

`search` and `product` ask the request router (`POST /v1/requests`) by intent: the
API picks the shop's endpoint, or a shopping search, and returns the same structured
answer as the MCP tools `search_products` and `get_product`. While an answer says
`"status": "working"`, the CLI waits as advised (`check_after_seconds`) and reads it
again with `GET /v1/requests/{id}`, then prints the answer unchanged. `--async`
returns the first answer instead. `--raw` adds the shop's own data where it has it.

Each submission sends a request key (`--request-key`, or a generated UUID), written
to stderr with the `request_id` even with `--quiet`. Submissions are **not retried
automatically**: after an ambiguous submission, run the same command with the same
`--request-key` to get the same request back instead of running it again. A
`failed` answer exits 1 and is printed unchanged. `--max-credits` is a budget: if the
request could cost more, nothing runs and nothing is charged.

`site` reads `GET /v1/sites` (search, product details and catalogue, each with
`available` and the most it costs). Use `discover` and `extract` only for one exact
endpoint, such as a shop's whole catalogue or several pages.

## Extract

```sh
# These examples submit real work; choose your own intended target.
dtwb extract amazon.pdp B012345678
dtwb extract amazon.search 'coffee beans' --parameters '{"max_pages":1}'

# Canonical blueprint IDs and full HTTPS URLs work for any discovered blueprint.
dtwb extract amazon.search_items 'https://www.amazon.co.uk/s?k=coffee'

# Return the exact submission JSON immediately, without polling:
dtwb extract --async amazon.search 'coffee beans' --idempotency-key coffee-run-001

# Later, read without submitting more work:
dtwb status JOB_UUID
dtwb retrieve JOB_UUID
dtwb retrieve JOB_UUID --wait
dtwb retrieve JOB_UUID --page-size 100 --cursor 'NEXT_CURSOR_FROM_PREVIOUS_PAGE'
dtwb retrieve JOB_UUID --format structured   # common product fields; both = raw and structured
```

`amazon.pdp` and `amazon.search` are aliases for the API IDs
`amazon.product_details` and `amazon.search_items`. An ASIN or search keyword
uses amazon.com; use a full URL for another supported marketplace. Parameters and
blueprint versions are not hardcoded: inspect the live catalog. Source validation,
maintenance, authorization and limits remain the server's responsibility.

By default, extraction submits once, waits according to ETA, poll guidance and
HTTP Retry-After, then returns **one unchanged API result page**. Stdout is one
JSON document, not a CLI envelope. Use `next_cursor` to fetch further pages,
with the **same page size**. The CLI does not concatenate pages and misrepresent
that as an unchanged API response. Discovery filters and paginates on the server,
not against a partial local list. Extraction resolves the exact blueprint's live
contract, so operations outside the first discovery page work too. This requires
the unified-discovery Jobs API rollout before releasing the updated CLI; an older
API is not silently treated as an empty search result.

`retrieve` without `--wait` performs one result read (pending jobs return
metadata). `status` reads metadata. Neither submits work. Failed, partial and
unavailable outcomes are terminal and are never automatically resubmitted.

Idempotency keys and accepted Job IDs are written to stderr even with `--quiet`.
Retain them. Submission POSTs are **not automatically retried**. After an ambiguous
submission, replay the original command with the same inputs and
`--idempotency-key`; after an accepted submission, resume with `retrieve --wait`.
Read-only requests retry HTTP 429/502/503/504 at most twice. A timeout or Ctrl-C
stops waiting, **does not cancel a server Job**, and preserves recovery details.

### Output / exit codes

- **stdout:** one JSON response on success; help/version are plain text.
- **stderr:** progress, approval instructions, recovery IDs, and structured JSON
  errors. `--quiet` hides routine progress; `--verbose` includes read retries.
- **0:** successful command, pending one-shot read, accepted async submission, or a
  `done`/`working` request answer.
- **1:** API/network/local failure, FAILED/UNAVAILABLE extraction/retrieval, or a
  `failed` request answer.
- **2:** invalid CLI input, or PARTIAL_COMPLETE extraction/retrieval (inspect JSON).
- **130 / 143:** interrupted by SIGINT / SIGTERM. Server work is retained.

A successful `status` read exits 0 even if the Job itself failed; inspect
`status` in its JSON. Error objects may include `job_id`,
`idempotency_key` and `resume`. Known credentials are redacted from errors.

## Configuration

| Option / variable | Default |
| --- | --- |
| `--api-url` / `DATAWEBOT_API_URL` | `https://api.datawebot.com` |
| `--auth-url` / `DATAWEBOT_AUTH_URL` | `https://mcp.datawebot.com` |
| `DATAWEBOT_API_KEY` | Saved issuer profile key |
| `DATAWEBOT_CONFIG_DIR` | `~/.datawebot` |
| `--timeout` | 600 seconds total, including requests/polling/retrieval |

Supply keys using your shell/tool's secret environment mechanism, never command
arguments or chat. Explicit environment keys are sent to the API origin you
select: only select trusted hosts. Saved keys are bound to their API/issuer pair;
legacy agent-setup profiles work only with the default production pair. Local or
staging targets require their own sign-in/profile or an explicit environment key.
Only HTTPS origins (no path/query/userinfo) are accepted; HTTP is allowed on
loopback for local tests. Redirects are rejected to avoid forwarding secrets.
No credentials are read for help/version.

## Current API limitations

See the public [API quickstart](https://www.datawebot.com/docs/api/quickstart)
and [agent guide](https://www.datawebot.com/docs/agents). Use `dtwb discover` for
the current blueprint versions, input schemas and availability.

- Account-wide listing requires a valid customer key and Jobs access.
  Live listing through this CLI has not been independently verified.
- `credits` returns `GET /v1/account` unchanged: the account's credits and any
  credits held for running requests.
- Live availability comes from discovery and API responses, not these examples.
- Tests use synthetic HTTP/device fixtures, not live email, paid data extraction
  or deployed acceptance. No server deployment is part of this repository.

## Maintainer release checks

The npm package is `@datawebot/cli`, exposing `dtwb`. Package contents
are allowlisted to `bin/` and `src/` plus npm's package/README/LICENSE defaults.
Commander.js is the only runtime dependency; npm is the sole package manager in
this standalone repo. CI checks Node 22/24 on Linux and Windows and installs a
packed tarball to verify the actual executable.

```sh
npm ci
npm test
npm audit --omit=dev
npm pack --dry-run
npm run test:package
# Inspect the archive before an authorized release.
```

The CLI is [MIT licensed](LICENSE). This license covers the CLI code; use of
the hosted service is governed by the [datawebot terms](https://www.datawebot.com/terms).

Releases publish from GitHub Actions (`.github/workflows/release.yml`) through npm
trusted publishing: npm accepts this repository's workflow, so no npm token is
stored anywhere. To release, with the owner's approval of the version and scope:

```sh
npm version patch        # or minor; commits the bump and tags v<version>
git push --follow-tags   # the tag runs the Release workflow
```

The workflow checks the tag matches `package.json`, runs the tests, the audit and
the packed-tarball check, then runs `npm publish` with provenance. Verify registry
metadata and a fresh registry installation afterward. No server deployment or
live extraction is implied by publishing the CLI.
