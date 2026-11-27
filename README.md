# mcp-server-synsbasen

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Synsbasen API](https://api.synsbasen.dk/v1/docs): Danish vehicle data from the Motor Register (DMR), periodic inspections, insurance, leasing, valuations, liens from the Personal Property Register and the model catalogue. It lets an MCP client (Claude or any other MCP-capable assistant) look vehicles up by registration number, VIN or image, and keep the account's watch list.

> This is an independent, unofficial project. It is not developed, endorsed or supported by Synsbasen.

- Read-only by default; the two watch list tools are opt-in per instance.
- One set of upstream credentials per server instance; the server does no per-user authorization itself (see [Security model](#security-model)).
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.

## Tools

| Tool | Purpose | Cost at Synsbasen |
|---|---|---|
| `synsbasen_search_capabilities` | Find the tools that fit a question. | None (no request) |
| `synsbasen_check_connection` | Check that the API key works. | 1 request |
| `synsbasen_get_token_balance` | Tokens left this period. | 1 request |
| `synsbasen_get_vehicle` | One vehicle by registration number, VIN or id, with optional free expansions (inspections, equipment, emission, engine, weight, body, periodic taxes, permits, leasing periods, stored valuations, ...). | 1 request |
| `synsbasen_search_vehicles` | Search or count vehicles by their attributes. | 1 request |
| `synsbasen_get_vehicle_dmr_data` | Live Motor Register data: insurance with history, next inspection, inspection notices, leasing, Euro norm, battery. | 1 token |
| `synsbasen_get_vehicle_liens` | Live liens and notices from the Personal Property Register, by VIN. **Personal data:** creditors and debtors can be private persons (name, birth date). | 1 token (none with an own certificate) |
| `synsbasen_get_vehicle_valuation` | The vehicle with live valuations. | 1 token when live, else none |
| `synsbasen_identify_vehicle_from_image` | Read the number plate in a photo and look the vehicle up. | 1 token |
| `synsbasen_search_leasing_periods` | Search leasing periods. | 1 request |
| `synsbasen_search_appraisals` | Search stored valuations. | 1 request |
| `synsbasen_get_inspection` | One inspection with faults found and the report link. | 1 request |
| `synsbasen_search_inspections` | Search inspections. | 1 request |
| `synsbasen_list_test_centers` | Active test centres. | 1 request |
| `synsbasen_get_test_center` | One test centre. | 1 request |
| `synsbasen_search_test_centers` | Search test centres, inactive ones included. | 1 request |
| `synsbasen_list_brands` | All brands. | 1 request |
| `synsbasen_get_catalog_entry` | One brand, model, variant or version, or the entries below it. | 1 request |
| `synsbasen_search_catalog` | Search one level of the model catalogue. | 1 request |
| `synsbasen_get_body_types` | Body types. | 1 request |
| `synsbasen_get_dealer_plate` | Insurance of a dealer plate, looked up live. | 1 token |
| `synsbasen_list_watched_vehicles` | The account's watch list. | Free |
| `synsbasen_get_watched_vehicle` | Whether one vehicle is watched. | Free |
| `synsbasen_watch_vehicle` *(write)* | Put a vehicle on the watch list (its changes go to the account's own webhooks). | Free |
| `synsbasen_unwatch_vehicle` *(write)* | Take a vehicle off the watch list. | Free |

Synsbasen counts every successful request against the subscription's monthly request quota, and the live lookups also use tokens from a monthly allowance that does not roll over (see the API documentation, "Usage Quota"). Only `200 OK` answers count. Expansions that cost tokens (`dmr_data`, `tinglysning_data`, live `appraisals`) are not offered on `get_vehicle`; each has its own tool, so a client can see the cost before it calls.

**Personal data.** The vehicle data is about vehicles, not owners: the API returns no owner, user, address or personal number. Two things can still be personal data: a registration number or VIN can point to a person through the owner, and the liens (`get_vehicle_liens`) name private creditors and debtors with their birth dates, as the Personal Property Register publishes them. The server passes on what Synsbasen returns for the account's key and keeps nothing; its audit log hashes registration numbers and VINs and keeps only the attribute names of a search.

Webhooks are configured in Synsbasen's dashboard and delivered to the account's own address; this server does not receive them.

## Quick start

Requires Node.js 22 or later and an API key for the Synsbasen API. Create an account at [api.synsbasen.dk](https://api.synsbasen.dk) (30 days free on the Advanced plan, no card) and copy the key from the dashboard.

```bash
npx mcp-server-synsbasen
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-synsbasen.git
cd mcp-server-synsbasen
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add synsbasen \
  --env SYNSBASEN_API_KEY=<key> \
  -- npx -y mcp-server-synsbasen
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "synsbasen": {
      "command": "npx",
      "args": ["-y", "mcp-server-synsbasen"],
      "env": {
        "SYNSBASEN_API_KEY": "<key>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-synsbasen`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name synsbasen-mcp -p 127.0.0.1:3000:3000 \
  -e SYNSBASEN_API_KEY=<key> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-synsbasen:latest

claude mcp add --transport http synsbasen http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `SYNSBASEN_AUDIT_LOG` into it (e.g. `-v synsbasen-audit:/audit -e SYNSBASEN_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Upstream API

| Variable | Default | Description |
|---|---|---|
| `SYNSBASEN_API_KEY` | – | **Required.** API key, sent as `Authorization: Bearer <key>`. |
| `SYNSBASEN_BASE_URL` | `https://api.synsbasen.dk/v1` | Base URL of the API. Must be `https` on `api.synsbasen.dk` (loopback `http` is allowed for local mocks). |
| `SYNSBASEN_ALLOW_CUSTOM_BASE_URL` | `false` | Allow a base URL on another host. |
| `SYNSBASEN_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `SYNSBASEN_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `SYNSBASEN_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

### Access control

| Variable | Default | Description |
|---|---|---|
| `SYNSBASEN_ENABLE_WRITES` | `false` | Enable the write tools. |
| `SYNSBASEN_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `synsbasen_` prefix. |
| `SYNSBASEN_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ids in clear text, free text hashed, duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP:

```ts
import { createSynsbasenGateway, synsbasenToolCatalog } from 'mcp-server-synsbasen/gateway';

const gateway = createSynsbasenGateway({ apiKey: tenant.apiKey });
const result = await gateway.callTool('get_vehicle', { registration: 'AB12345' }, { caller: 'person-1' });
```

- **Explicit credentials.** `apiKey` is required; a missing value throws when the gateway is created. `baseUrl` defaults to Synsbasen's one address (`SYNSBASEN_BASE_URL` export), and a gateway refuses any other: no other host, subdomain or loopback address, whatever `allowCustomBaseUrl` says. A host stands in for Synsbasen in tests with `fetchImpl`. A gateway never reads `SYNSBASEN_API_KEY` or `SYNSBASEN_BASE_URL` from the environment, so one tenant cannot silently fall back to the process's credentials. The stdio and HTTP transports still read them from the environment.
- **Several tenants in one process.** Create one gateway per set of credentials. Each instance redacts error text, tool results and audit records with its own key only; no secret is kept in a process-wide registry, and a dropped instance releases its key.
- **Instance policy from the host.** Pass `policy` to `createSynsbasenGateway`: `enableWrites` (default false), `disabledTools` (must name known tools) and `audit`, a function that receives each audit record instead of `SYNSBASEN_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads none of `SYNSBASEN_ENABLE_WRITES`, `SYNSBASEN_DISABLED_TOOLS`, `SYNSBASEN_AUDIT_LOG` or `SYNSBASEN_ALLOW_CUSTOM_BASE_URL`, so tenants in one process can have different settings. Without `policy` the instance uses the environment, like the MCP server. Each call runs in a scope of its own, so a call made from inside another instance's call never inherits its policy, sink or redactor, and every audit record is redacted as a whole with the instance's own key before the sink sees it. The limits (`SYNSBASEN_TIMEOUT_MS`, ...) are still read from the environment and apply to every gateway in the process. Per-user and per-tenant authorization is the host's job.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON, as the MCP specification recommends (many clients read only the text). The JSON is built from the redacted result, so it holds exactly `structuredContent`. An error result has only its text, and, when the upstream API answered with an HTTP error, `failure: { httpStatus, requestId? }`: the status, and the vendor's request id from a response header (`REQUEST_ID_HEADERS` in `src/errors.ts`) only when it is a hex id of 8 to 64 characters (one run of hex digits, or groups of four or more joined by single hyphens, as in a UUID) and does not hold the shape of a personal number. A host can count failures from it without reading their text. Never the response body, the vendor's error code or message.
- **Act as a person.** A host that has verified the person a call is made for passes `actAs: { email, name? }` in the call context (`src/act-as.ts`). A handler reads it with `currentActAs()` and makes the call's changes as the person's own user in the system, found by that email (a header or a user field, as the vendor documents it). When the person has no single active user there, or the key may not act for others, the handler throws `ActAsRefusedError` and the result is an error with `actAsRefused` (`no_user`, `not_permitted`) and a fixed text: a change is never made as the key's own user instead. A malformed `actAs` refuses the call (`invalid`) before anything is sent. Whether a read also goes as the person is decided per server and written in its README. The server adds the email to no audit record, text or field of its own; data the system returns is passed on as it is. Only an absent `actAs` means no person (`null` is refused). Without `actAs` every call runs as the key's own user. Synsbasen has no users behind a key, so every call runs as the account; the context is carried, and a host's `actAs` changes nothing at Synsbasen.
- **Tool catalog.** `synsbasenToolCatalog` is a frozen list of every tool: `name` (without the `synsbasen_` prefix), `title`, `description`, `riskLevel` (`read`, `write` or `destructive`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (true when a tool can read more than its name says, so a host gives it only to roles that may read everything) and `upstream`, the API requests the tool may make (`access`, `method` and path template). It is generated from the same tool table as the MCP server, so it cannot drift from the registered tools. `synsbasenGatewayTools` holds the same definitions without `upstream` and `broad`; `gateway.tools` lists those enabled on the instance.

## Threat model

What this server guarantees about the API key, and what it does not. It is
the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one key, keeps best-effort
redaction: its errors and audit records are redacted with its key, but it is
not held to these guarantees.

**Guaranteed:**

- **(a) The key never reaches anything persisted or shared:** audit sinks and
  the audit log file, logs, error texts, export hooks or files. Errors are
  our own texts; audit records and everything a gateway instance returns are
  redacted with the instance's own key before they leave it.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a vendor message or
  code, a redirect's `Location`, a type or field name from the vendor, or
  the message of an error thrown while reading a response. A failure kept
  inside an otherwise returned result is the status or a fixed text as well.
  Errors never quote the key, the configured address or a refused configuration value (a timeout names its limit in milliseconds).
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The MCP server serves one key.

**Not guaranteed (residual risk):** a vendor that deliberately echoes the
customer's own key back in data. Results are redacted on a best-effort
basis: the exact key, its URL- and JSON-encoded forms and any piece of it of
6 characters or more, in strings, object keys and the string form of
numbers and booleans, are replaced by `"‹redacted›"` before anything is
serialised. A key that comes back otherwise transformed (split into pieces
shorter than 6 characters, reversed, re-encoded, hashed) is not recognised.
Such data reaches only the tenant whose key it is, which already holds the
key. **What leaves a gateway holds no piece of the key.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the key (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included), audit records and stderr lines, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a key that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Key admission.** Every key is a secret the vendor issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the key. As a cheap first filter it also
refuses a key that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the key. The standalone MCP server applies the same redaction to errors
and audit records on a best-effort basis; its successful results are passed
on as the API returned them.

## Security model

- **One shared identity.** Every caller acts with the rights of the configured API key. Give it the least rights that work and rotate it regularly.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees everything the API key can see. To separate data, run several instances with different keys.
- **Writes are off by default.** The only writes are the watch list tools, annotated as non-destructive and idempotent: they delete no data and each undoes the other. Read-only tools get a client that refuses non-GET requests, except a POST to a `.../search` endpoint or to `/vehicles/by_image`, which only read. When `SYNSBASEN_AUDIT_LOG` is set, a write tool does not run unless its start record is written; without it there is no audit record.
- **Upstream content is untrusted input.** Data returned by the API may be written by anyone with access to it. Tool results label it as data; clients that combine this server with other tools should treat it accordingly.
- **The API key stays on the API origin.** Redirects are never followed, the base URL must use `https`, and error messages and audit records are redacted (by each instance, with that instance's key) and size-capped. See the threat model above for what is and is not guaranteed.
- **The HTTP transport fails closed.** It refuses to start on a non-loopback address or with any origin allowed unless a token is set, compares tokens in constant time, throttles failed authentication per client address, checks `Origin` and `Host` (DNS rebinding), and caps request bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

Project layout:

| Path | Contents |
|---|---|
| `src/tools/synsbasen.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/synsbasen/` | Upstream client, API calls, policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml` (and [docs/NEW-SERVER.md](docs/NEW-SERVER.md)).

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them.
