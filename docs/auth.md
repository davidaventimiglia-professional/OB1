# Authentication — OAuth 2.1 Resource Server

> **BREAKING CHANGE.** The core Open Brain MCP server no longer uses a static
> `x-brain-key` / `MCP_ACCESS_KEY` (or `?key=...` in the URL). It is now an
> **OAuth 2.1 resource server**. Clients authenticate with a Bearer access token
> issued by Supabase Auth. If you previously connected with a key in the URL or
> an `x-brain-key` header, you must re-connect using the OAuth connector flow
> described below.

This document is the canonical reference for how the core
`server/` MCP function (`open-brain-mcp`) authenticates requests.

> **Scope.** This applies to the **core** `open-brain-mcp` server only.
> Independent community contributions under `recipes/` and
> `schemas/per-agent-identity/` ship their own auth contracts (some still use a
> static key); they are out of scope here and are unaffected by this change.

## Overview

Previously, the MCP server authenticated requests with a single shared static
key (`x-brain-key` / `MCP_ACCESS_KEY`) set at deploy time — every client used
the same secret and had access to the same data. The server is now an **OAuth
2.1 resource server**: each request must carry a Bearer access token issued to a
specific authenticated user. The tenant is the authenticated user, and data is
scoped by RLS policies keyed on `auth.uid()`, so each user sees only their own
thoughts.

For step-by-step setup instructions, see [oauth-setup.md](oauth-setup.md).

- The core open-brain MCP server is an OAuth 2.1 **resource server (RS)**.
- **Supabase Auth** is the **authorization server (AS)**.
- Access tokens are Supabase-issued **JWTs**, verified on every request by
  signature, issuer, and expiry against the AS's published JWKS, plus a
  `client_id` claim check (see [Token model](#token-model--audience-caveat)).
- The static `x-brain-key` / `MCP_ACCESS_KEY` model is **retired**. There is no
  shared secret in the URL or in a header anymore.

The implementation lives in `server/auth.ts` (side-effect-free helpers,
unit-tested in `server/auth_test.ts`) and `server/index.ts` (the Hono app that
wires discovery, the 401 challenge, and per-request RLS clients).

## Environment variables / Supabase secrets

The function reads the following from the environment (set them as Supabase
secrets with `supabase secrets set NAME=value`):

| Variable | Purpose | Example |
| --- | --- | --- |
| `OAUTH_ISSUER` | The Supabase Auth issuer URL (the AS). | `https://<ref>.supabase.co/auth/v1` |
| `OAUTH_CLIENT_ID` | The single registered OAuth client id this RS accepts. Tokens whose `client_id` claim differs are rejected. | `<client-id-from-dashboard>` |
| `OAUTH_RESOURCE` | The canonical resource identifier — exactly this function's URL. Used in discovery metadata and the `WWW-Authenticate` challenge. | `https://<ref>.supabase.co/functions/v1/open-brain-mcp` |
| `SUPABASE_ANON_KEY` | Combined with the caller's JWT to build the per-request, RLS-scoped Supabase client. | `<anon-key>` |

> **No longer used by the core function:**
>
> - `SUPABASE_SERVICE_ROLE_KEY` — the function now runs every data query as the
>   caller (anon key + caller JWT → `authenticated` role), so it does **not** use
>   the service-role key. RLS does the scoping.
> - `MCP_ACCESS_KEY` — the retired static key. Remove it from your secrets and
>   **rotate** it if it was ever exposed (see [Manual prerequisites](#manual-prerequisites)).

`SUPABASE_URL` is automatically available inside Edge Functions.

> **`OAUTH_CLIENT_SECRET` is not read by this function.** The resource server
> only verifies access tokens; the authorization-code exchange that uses the
> client secret is performed by the connector / authorization server, not the
> RS. The secret is captured at client registration — see
> [Manual prerequisites](#manual-prerequisites) — and used by the OAuth /
> connector flow, so it does **not** need to be set as a function secret.

## `verify_jwt = false` requirement

This function **must** be deployed with JWT verification disabled at the
platform gateway. In `supabase/config.toml`:

```toml
[functions.open-brain-mcp]
verify_jwt = false
```

…or deploy with `--no-verify-jwt`.

**Why:** the function owns its own authentication. It returns its own `401` with
the RFC 9728 `WWW-Authenticate: Bearer resource_metadata="…"` challenge, and it
serves the public discovery routes (`/.well-known/oauth-protected-resource`) with
**no** auth. If `verify_jwt = true`, the Supabase platform gateway would
intercept requests first and return its **own** `401` for any request without a
valid platform JWT — shadowing the discovery routes and the resource-server
challenge before the function ever runs. Disabling gateway verification lets the
function implement the full OAuth resource-server contract itself.

## Discovery URLs

| Document | URL | Spec |
| --- | --- | --- |
| Protected-resource metadata | `<resource>/.well-known/oauth-protected-resource` | RFC 9728 |
| Authorization-server metadata | `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1` | RFC 8414 |

- The protected-resource metadata (served by this function, unauthenticated)
  advertises the `resource` id and its `authorization_servers` (the issuer).
- The AS metadata (served by Supabase) advertises the authorization/token
  endpoints and the `jwks_uri`.
- **JWKS is resolved at runtime** from the AS metadata's `jwks_uri` — it is never
  hardcoded. The function fetches the AS metadata, reads `jwks_uri`, caches it,
  and verifies token signatures against that key set (`resolveJwksUri` +
  `createTokenValidator` in `server/auth.ts`).

A `401` from the protected endpoint includes:

```text
WWW-Authenticate: Bearer resource_metadata="https://<ref>.supabase.co/functions/v1/open-brain-mcp/.well-known/oauth-protected-resource"
```

which points the client at the protected-resource metadata so it can discover
the AS and run the authorization-code flow.

## Token model / audience caveat

Supabase access tokens are JWTs that carry:

- `role: "authenticated"`
- a **generic** `aud: "authenticated"` — **not** the resource URI.

Because the `aud` is generic, this RS cannot bind a token to itself by checking
`aud`. Instead it binds to the resource by:

1. Verifying signature + issuer (`OAUTH_ISSUER`) + expiry against the AS JWKS.
2. Checking the token's **`client_id` claim equals `OAUTH_CLIENT_ID`** (the
   single registered client) — this is the **audience** check.
3. Enforcing **RLS keyed on `user_id = auth.uid()`** (the JWT `sub`) on the data
   layer — this is the **tenancy** boundary.

### Residual confused-deputy risk

Because `aud` is generic, any Supabase access token minted for this project's
`authenticated` role and carrying the matching `client_id` would pass the
audience check. The `client_id` binding plus per-user RLS mitigates this, but
the token is not cryptographically scoped to this exact resource URI. (Note that
even so, RLS still confines any such token to its own user's rows.)

**Optional hardening — Custom Access Token Hook.** Configure a Supabase
[Custom Access Token Hook](https://supabase.com/docs/guides/auth/auth-hooks)
to set `aud` = the resource URI (`OAUTH_RESOURCE`). The validator could then
additionally enforce `aud === OAUTH_RESOURCE`, closing the confused-deputy gap.
This is optional and not required for the base flow.

## Row-Level Security (RLS)

Data is scoped **per user (tenant)**. A user's brain follows the human across any
OAuth client; `client_id` is kept only as provenance. See `schemas/oauth-rls/`
for the migration:

- Adds a `user_id uuid` tenant column (indexed, defaulting to `auth.uid()`, FK to
  `auth.users`) to `thoughts`, and keeps `client_id` as non-scoping provenance.
- Four RLS policies for the `authenticated` role (SELECT/INSERT/UPDATE/DELETE),
  each keyed on `user_id = auth.uid()`.
- `upsert_thought` and `match_thoughts` redefined as `SECURITY INVOKER` so they
  run as the calling user and stamp/filter by `user_id`.

> **Legacy rows.** Rows created before the migration have `user_id IS NULL`.
> The authenticated-role policies require `user_id = auth.uid()`, so those legacy
> rows are **invisible to OAuth clients** until they are backfilled with a real
> user id. They remain accessible to the service role.

## Deploy seam

`supabase/functions/open-brain-mcp` is a **directory symlink** to `../../server`,
so the deployed function and the source in `server/` are a single source of
truth. Deploy and verify with:

```bash
supabase functions deploy open-brain-mcp --no-verify-jwt
```

If the bundler will not follow the symlink, fall back to copying the source into
the function directory before deploying:

```bash
rm -rf supabase/functions/open-brain-mcp
mkdir -p supabase/functions/open-brain-mcp
cp server/*.ts server/deno.json supabase/functions/open-brain-mcp/
supabase functions deploy open-brain-mcp --no-verify-jwt
```

### Tool descriptions and the connector cache

MCP clients (including Claude.ai) read each tool's `name`, `description`, and
input schema from the **deployed** function and **cache the tool list per
connector**. So a change to tool metadata in `server/index.ts` — e.g. the
`search` / `search_thoughts` descriptions — is not visible to a client until you
both redeploy **and** refresh the connector:

1. **Redeploy the function** so the new descriptions are live:

   ```bash
   supabase functions deploy open-brain-mcp --no-verify-jwt
   ```

2. **Refresh the connector** so the client re-reads the tool list. In Claude.ai
   this usually means **removing and re-adding** the custom connector (Settings →
   Connectors); a cached tool list will otherwise keep serving the old
   descriptions.

3. **Verify the change took effect.** For description/routing changes, ask a
   question that should now hit the updated tool and confirm the client selects
   it. (Tool selection is probabilistic: a sharper description improves the odds
   that the model picks this server over a competing source connector for an
   ambiguous query, but does not guarantee it. The most deterministic lever is a
   client-side instruction or preference.)

## Manual prerequisites

These are hosted / Supabase-dashboard actions performed **outside** this repo —
they are not done in code:

1. **Enable Authentication → OAuth Server** in the Supabase dashboard, with
   **dynamic client registration OFF**. Set **Site URL** to the **Vercel consent
   app's** production origin (e.g. `https://<your-app>.vercel.app`) and
   **Authorization Path** to `/oauth/consent`. Combined, these make the consent
   URL `<vercel-origin>/oauth/consent`.
2. **Deploy the consent page to Vercel.** It is a **Next.js app in this repo** at
   `oauth-consent/`, deployed with `vercel --prod` (see `oauth-consent/README.md`).
   Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (use the
   Supabase **publishable** key) in the Vercel project's environment. It is hosted
   on Vercel rather than as a Supabase Edge Function because Supabase rewrites
   Edge-Function HTML on the default `*.supabase.co` domain to `text/plain` with a
   `sandbox` CSP (real HTML there needs a Pro custom domain), which breaks an
   interactive consent page.
3. **Enable the GitHub auth provider** (register a GitHub OAuth app and set its
   client id/secret in the dashboard; its Authorization callback URL is
   `https://<project-ref>.supabase.co/auth/v1/callback`). The consent page signs
   the user in with GitHub before showing the approve/deny screen.
4. **Add `<vercel-origin>/auth/callback` to the redirect allow-list**
   (`additional_redirect_urls`). This is the **user-login** return URL the consent
   app passes to `signInWithOAuth` — distinct from Claude's OAuth-*client* redirect
   URI in the next item.
5. **Register the OAuth client** and capture its `client_id` and `client_secret`.
   Set `OAUTH_CLIENT_ID` as a function secret. The **`client_secret`** is **not**
   read by this function — it is used by the connector / authorization-server
   authorization-code exchange, so provide it to that flow (e.g. the connector
   registration) rather than as a function secret.

   > **`token_endpoint_auth_method: client_secret_post` required.** Supabase
   > confidential clients default to `client_secret_basic` (credentials in the
   > `Authorization` header), but Claude sends credentials in the POST body
   > (`client_secret_post`). A mismatch causes `invalid_credentials` at the token
   > endpoint. When registering the client, explicitly set
   > `token_endpoint_auth_method` to `client_secret_post` in the dashboard or via
   > the Supabase Auth admin API.
6. **Obtain Claude's exact redirect URI** from the connector dialog on
   claude.ai and register it **verbatim**. Redirect URIs are matched by exact
   string; a trailing slash or case difference will fail.
7. **Set the env secrets** listed in
   [Environment variables](#environment-variables--supabase-secrets).
8. **Rotate the old exposed `MCP_ACCESS_KEY`.** It is no longer used by the core
   function and should be invalidated if it was ever exposed. *(Done — revoked via
   `supabase secrets unset MCP_ACCESS_KEY`.)*

## How to verify

1. **Discovery — protected resource:**

   ```bash
   curl -s https://<ref>.supabase.co/functions/v1/open-brain-mcp/.well-known/oauth-protected-resource | jq .
   ```

   → valid JSON with `resource` and `authorization_servers`.

2. **Discovery — authorization server:**

   ```bash
   curl -s https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1 | jq .
   ```

   → valid JSON with `issuer`, `authorization_endpoint`, `token_endpoint`,
   `jwks_uri`.

3. **Unauthenticated request → 401 + challenge:**

   ```bash
   curl -i -X POST https://<ref>.supabase.co/functions/v1/open-brain-mcp
   ```

   → HTTP `401` with a
   `WWW-Authenticate: Bearer resource_metadata="…"` header.

4. **End-to-end:** complete the connector flow in claude.ai (Settings →
   Connectors → Add custom connector → paste the function URL, **not** a
   `?key=` URL) and confirm the Open Brain tools appear and work.
