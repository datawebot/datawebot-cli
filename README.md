# datawebot CLI

Agent-friendly API wrapper for [datawebot](https://www.datawebot.com), built with
[Commander.js](https://github.com/tj/commander.js). Executable: **dtwb**.

**Initial 0.x preview.** Node **22.12+** is required. No build step. Source
availability and npm installation do not grant access to restricted blueprints.

## Install

**npm publication is pending:** the first publish attempt was blocked by npm's
2FA requirement. The registry package is not available yet. Until publishing is
verified, use [the local installation steps](#develop--install-locally).
The npm commands below are the intended installation commands after release:

```sh
npm install --global @datawebot/cli@0.1.0
dtwb --version
dtwb --help
```

Or run without a global install:

```sh
npx --yes --package=@datawebot/cli@0.1.0 dtwb --help
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
dtwb man amazon.product_details
dtwb credits
dtwb jobs
dtwb jobs --page-size 25 --cursor 'NEXT_CURSOR_FROM_PREVIOUS_JOBS_PAGE'
```

`jobs` lists this account’s active and past Jobs, newest first, returning one
unchanged API page. Use its `next_cursor` to continue; the CLI does not filter
statuses, combine pages, or substitute machine-local history. Listing uses
`GET /v1/jobs` with your customer key. Availability and access are determined by
the API; the CLI does not bypass permissions or maintenance.

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
that as an unchanged API response. Discovery without a query is unchanged;
filtered discovery keeps catalog metadata and filters only `blueprints`.

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
- **0:** successful command, pending one-shot read, or accepted async submission.
- **1:** API/network/local failure, or FAILED/UNAVAILABLE extraction/retrieval.
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
- `credits` returns `GET /v1/account` unchanged. Its current synthetic,
  unbilled allowance is **not** a real wallet balance or pricing policy.
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

Each release requires owner approval of the version, scope and verification
limits. Verify publishing rights to the `@datawebot` npm scope; GitHub org
membership does not grant npm access. Configure npm authentication/2FA or trusted
publishing outside this repository—never commit credentials.

`prepack` runs the offline test suite. `npm publish --access public` is the manual
release step; publishing is not automated by CI. Verify registry metadata and a
fresh registry installation afterward. No server deployment or live extraction
is implied by publishing the CLI.
