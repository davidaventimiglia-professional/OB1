# OAuth Consent Edge Function — Design

**Date:** 2026-06-16
**Branch:** `feat/oauth-resource-server`
**Status:** Approved design, pending implementation plan

## Context

The Open Brain MCP server has been converted into an OAuth 2.1 **resource server**
(see `docs/auth.md` and `schemas/oauth-rls/`). The Supabase project's OAuth 2.1
**authorization server** is enabled, with Dynamic Client Registration OFF (we use a
pre-registered client). When an OAuth client (Claude) initiates the authorization
flow, Supabase Auth redirects the user's browser to a **consent page** at
`Site URL + Authorization Path` with an `?authorization_id=...` query parameter.

That consent page does not exist yet. This spec designs it as a **Supabase Edge
Function**, the only Supabase-native option: the project apex domain serves only
fixed API prefixes (`/auth/v1`, `/rest/v1`, `/functions/v1`, `/storage/v1`) — it
cannot serve a static page at `/oauth/consent`, and the Data API (PostgREST) cannot
return `text/html` under Supabase's gateway. So the consent UI must be an Edge
Function under `/functions/v1/...`.

This is **prerequisite #2** of the resource-server cutover (build/host the consent
page). It is a stretch goal: full projects typically host this on Vercel/Netlify,
but we are deliberately keeping it on Supabase.

## Tenancy model (foundational)

Open Brain is multi-tenant where **tenant = authenticated user**. RLS on `thoughts`
bulkheads by `user_id = auth.uid()` (the JWT `sub`); a user's brain follows the
human across any OAuth client. `client_id` is retained only as provenance and as the
audience check in token validation. (This was corrected in commit `625c862`; see
`schemas/oauth-rls/`.)

Consequence for consent: **any authenticated user may sign up and consent.** A new
user gets an isolated, empty brain — not access to anyone else's. Therefore the
consent page needs **no owner allow-list**; tenancy isolation is the protection.

## Decisions (locked)

| Decision              | Choice                                                                                                         |
|-----------------------|----------------------------------------------------------------------------------------------------------------|
| Hosting               | Supabase Edge Function at `/functions/v1/oauth-consent`, `verify_jwt = false`                                  |
| Login method          | Social OAuth, **GitHub only**                                                                                  |
| Who may consent       | Any authenticated user (no allow-list); tenancy isolates brains                                                |
| Session/PKCE handling | `@supabase/ssr` `createServerClient` + cookie adapters, `flowType: 'pkce'`                                     |
| Web framework         | Hono (consistent with the MCP server)                                                                          |
| CSRF                  | Double-submit cookie (random token in cookie + form field) — no server secret                                  |
| Repo placement        | top-level `oauth-consent/` (parallel to `server/`) + `README.md` + `metadata.json`; symlinked to `supabase/functions/oauth-consent` |

## Architecture

A new, **separate** Edge Function `oauth-consent`, independent of `open-brain-mcp`.
It is the authorization-server-side consent UI and shares nothing with the resource
server except the Supabase project. `verify_jwt = false` because it must be publicly
reachable and performs its own authentication.

Dashboard configuration this design assumes:
- **Site URL** = `https://cznjlmqnxoaykcdzbjry.supabase.co`
- **Authorization Path** = `/functions/v1/oauth-consent`

## Routes & data flow

The function is hit up to three times per authorization: initial load, GitHub
callback (same entry route, `code` present), and the decision POST. Session/PKCE
state is threaded through HttpOnly cookies managed by `@supabase/ssr`.

### `GET /functions/v1/oauth-consent?authorization_id=X[&code=Y]`

1. If `code` is present → `exchangeCodeForSession(code)` (reads the PKCE
   `code_verifier` cookie written during sign-in), set session cookies, continue as
   authenticated.
2. Else, load the session from cookies.
3. **Authenticated** → `supabase.auth.oauth.getAuthorizationDetails(X)` → render the
   consent screen: requesting application name and requested scopes, with **Approve**
   and **Deny** buttons that POST to the decision route.
4. **Not authenticated** → call
   `signInWithOAuth({ provider: 'github', options: { redirectTo: <this route URL with authorization_id> } })`
   (this writes the `code_verifier` cookie via the cookie adapter), then render a
   minimal landing page: "Continue with GitHub to authorize \<app\>", linking to the
   returned provider URL.

`redirectTo` is the same entry route (carrying `authorization_id`); on return,
`code` is present and step 1 handles it. This keeps a single entry route rather than
a separate callback path.

### `POST /functions/v1/oauth-consent/decision`

Form body: `authorization_id`, `decision` (`approve` | `deny`), CSRF token.

1. Require an authenticated session; if absent, redirect to the GET entry to re-auth.
2. Verify the CSRF token (double-submit: form field must equal the cookie value).
3. `approve` → `supabase.auth.oauth.approveAuthorization(authorization_id)`;
   `deny` → `supabase.auth.oauth.denyAuthorization(authorization_id)`.
4. Both return `{ redirect_url }` → respond `302` to that URL (back to the OAuth
   client, i.e. Claude).

## Components / files

Under top-level `oauth-consent/` (parallel to `server/`):

- `index.ts` — Hono app: the two routes, the `@supabase/ssr` server-client factory,
  and the cookie get/set adapters bridging Hono's cookie helpers.
- `consent_page.ts` — **pure** HTML rendering: consent screen, sign-in landing, and
  error page. No Supabase client references.
- `decision.ts` — **pure** helpers: CSRF token generation/compare, decision parsing,
  and the request-branch decision (session / no-session / code-present) expressed
  against a thin interface so it can be unit-tested with a fake.
- `deno.json` — imports: `hono`, `@supabase/ssr`, and a pinned `@supabase/supabase-js`
  **new enough to expose `auth.oauth.*`** (see Open Questions).
- `README.md` + `metadata.json` — per repo contribution conventions.

Deploy seam: `supabase/functions/oauth-consent` → symlink to
`../../oauth-consent` (mirrors the `open-brain-mcp` → `server` symlink).
Function config sets `verify_jwt = false`.

## Environment / secrets

The function needs only:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

The `@supabase/ssr` client uses the anon key plus the user's cookie session. GitHub
provider configuration and the redirect allow-list live at the **project** level, not
in function env. CSRF uses a double-submit random cookie, so no server-side signing
secret is required.

## Error handling

| Condition                                            | Response                                                             |
|------------------------------------------------------|----------------------------------------------------------------------|
| Missing `authorization_id`                           | `400` with a short explanation                                       |
| `getAuthorizationDetails` fails (invalid/expired id) | Friendly "this authorization request has expired or is invalid" page |
| `exchangeCodeForSession` fails                       | Error page with a retry link                                         |
| `approve`/`deny` upstream failure                    | `502` error page                                                     |
| Unauthenticated POST to `/decision`                  | Redirect to GET entry to re-authenticate                             |
| CSRF token mismatch                                  | `403`                                                                |

## Testing

- **Unit (Deno):** the pure pieces — HTML rendering output, CSRF generate/compare,
  decision and query parsing, and the branch logic (given session / no-session /
  code-present) against a faked Supabase interface.
- **Integration (manual):** the real claude.ai connect flow end to end — add the MCP
  function URL as a connector, complete GitHub login + consent, and confirm tokens
  are issued and `capture_thought` / `search_thoughts` work, with rows scoped to the
  authenticated user.

## New manual prerequisites introduced by this design

1. **Enable the GitHub provider** in Supabase Auth (register a GitHub OAuth app; set
   its client id/secret in the dashboard).
2. **Add `https://cznjlmqnxoaykcdzbjry.supabase.co/functions/v1/oauth-consent` to the
   redirect allow-list** (`additional_redirect_urls`). This is the *user-login* return
   URL — distinct from Claude's OAuth-*client* redirect URI.

These join the existing resource-server prerequisites in `docs/auth.md`.

## Resolutions & verification items

1. **`supabase-js` version with `auth.oauth.*` — decided.** The `2.47.10` pinned in
   `server/` predates the OAuth-server consent methods. **Pin a later `@supabase/supabase-js`
   in the consent function's `deno.json`** that exposes
   `auth.oauth.getAuthorizationDetails` / `approveAuthorization` / `denyAuthorization`.
   The implementation plan must identify the specific minimum version and confirm it
   resolves cleanly under `@supabase/ssr`. (REST-call fallback is no longer the plan;
   pin the version that has the methods.)
2. **`@supabase/ssr` under Deno edge runtime — expected to work.** Framework-agnostic
   (cookie `getAll`/`setAll` adapters). Confirm it imports and runs during
   implementation; no design change anticipated.
3. **`auth.uid()` resolves from OAuth-server tokens — expected to work.** Issued access
   tokens should carry `sub` = the user id. Confirm against a real token in the
   end-to-end test; no design change anticipated.
4. **Multi-segment `authorization_url_path` — expected to work.** Supabase should accept
   `/functions/v1/oauth-consent` (simple concatenation with Site URL). Confirm when
   setting the Authorization Path; no design change anticipated.

## Out of scope

- Styling beyond a clean, minimal consent screen.
- Multiple identity providers (GitHub only for now).
- Owner allow-listing (intentionally omitted; tenancy isolation is the control).
- Registering the pre-registered OAuth client and Claude's redirect URI (separate
  resource-server prerequisites).
