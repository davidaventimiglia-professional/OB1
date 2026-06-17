# OAuth Consent App on Vercel — Design

**Date:** 2026-06-17
**Branch:** `feat/oauth-resource-server`
**Status:** Approved design, pending implementation plan
**Supersedes:** the hosting approach in `2026-06-16-oauth-consent-edge-function-design.md` (the consent flow/decisions there still hold; only the runtime/host changes).

## Why this exists

The consent page was first built as a Supabase Edge Function (Deno/Hono). That approach is **blocked by the platform**: Supabase rewrites HTML served from Edge Functions on the default `*.supabase.co` domain to `content-type: text/plain` with a `default-src 'none'; sandbox` CSP, and only allows real HTML with a **Custom Domain (Pro plan)**. Verified empirically (our function returned 200 but `text/plain` + sandbox CSP, which blocks rendering and form submission) and in Supabase docs/discussions. We are not paying for Pro, so the consent UI moves to **Vercel**, where HTML renders freely on the default `*.vercel.app` domain.

Only the consent UI moves. Supabase remains the OAuth 2.1 **authorization server**, the **GitHub identity provider**, the **JWKS** issuer, and the **RLS-scoped data backend** (`schemas/oauth-rls/`, keyed on `user_id = auth.uid()`). The OAuth resource server (`server/`) is unchanged.

## Locked decisions

| Decision | Choice |
|----------|--------|
| Host | Vercel, default `*.vercel.app` production URL (no custom domain) |
| Framework | Next.js 16 App Router + React 19 (matches `dashboards/open-brain-dashboard-next` versions) |
| Session/PKCE | `@supabase/ssr` `createServerClient` + Next `cookies()`, session refresh in `middleware.ts` (canonical Supabase Next.js SSR pattern; introduced fresh — the repo has no existing SSR usage) |
| Login | Social OAuth, **GitHub only** |
| Who may consent | Any authenticated user (no allow-list); per-user RLS isolates each tenant's brain |
| CSRF | **Next Server Action** built-in Origin-based CSRF protection (drop the manual double-submit token the Deno version used) |
| Repo placement | Replace the top-level `oauth-consent/` directory in place (delete Deno files, build the Next.js app there) |
| Deploy | Vercel CLI (`vercel` preview, `vercel --prod` production) |
| supabase-js | `@supabase/supabase-js@2.108.2` (auth-js 2.108.2 exposes `auth.oauth.*`) via `@supabase/ssr` |

## Routes & flow (App Router)

The Supabase OAuth server redirects the browser to `Site URL + Authorization Path` = `<vercel-origin>/oauth/consent?authorization_id=…`.

1. **`app/oauth/consent/page.tsx`** (Server Component) — reads `authorization_id` from search params; builds a server Supabase client and calls `getUser()`.
   - **Missing `authorization_id`** → render an error state.
   - **No user** → redirect to `app/auth/signin/route.ts` (carrying `authorization_id`).
   - **User present** → `supabase.auth.oauth.getAuthorizationDetails(authorizationId)`:
     - error / invalid id → render "expired or invalid" error state;
     - response is the already-consented redirect shape (no `authorization_id` field) → `redirect(details.redirect_url)`;
     - otherwise render the consent form: client name + requested scopes, Approve / Deny.
2. **`app/auth/signin/route.ts`** (Route Handler) — calls
   `signInWithOAuth({ provider: 'github', options: { redirectTo: <origin>/auth/callback?authorization_id=… } })`
   and redirects the browser to the returned GitHub URL. (`@supabase/ssr` writes the PKCE `code_verifier` cookie.)
3. **`app/auth/callback/route.ts`** (Route Handler) — GitHub→Supabase returns here with `?code` and the preserved `authorization_id`; `exchangeCodeForSession(code)`, then `redirect('/oauth/consent?authorization_id=…')`.
4. **Approve/Deny → `decideAction` Server Action** (`app/actions.ts`), bound to the form's two submit buttons. Validates the decision, then calls
   `approveAuthorization(id, { skipBrowserRedirect: true })` or `denyAuthorization(id, { skipBrowserRedirect: true })`
   and `redirect()`s to the returned `redirect_url` (back to the OAuth client). CSRF is handled by Next's built-in Server Action Origin check.
5. **`middleware.ts`** — refresh the Supabase auth cookies on each request (canonical SSR pattern).

`skipBrowserRedirect: true` is required on `signInWithOAuth`, `approveAuthorization`, and `denyAuthorization` because these run server-side (no browser `window`); we issue the redirect ourselves.

## Files (under `oauth-consent/`)

- `package.json` — `next@16.2.4`, `react@19.2.4`, `react-dom@19.2.4`, `@supabase/ssr`, `@supabase/supabase-js@2.108.2`.
- `next.config.ts`, `tsconfig.json`, `.gitignore` (node_modules, `.next`, `.vercel`).
- `middleware.ts` — session refresh.
- `lib/supabase/server.ts` — `createClient()` server factory (cookies-backed).
- `lib/supabase/middleware.ts` — `updateSession(request)` helper used by `middleware.ts`.
- `lib/oauth.ts` — **pure** helpers: `parseScopes(scope: string): string[]`, `parseDecision(raw): 'approve'|'deny'|null`, and the `isConsentDetails` narrowing for the `getAuthorizationDetails` union. No framework imports.
- `app/layout.tsx` — minimal root layout + basic styling.
- `app/oauth/consent/page.tsx` — entry Server Component.
- `app/oauth/consent/consent-form.tsx` — the Approve/Deny form (Server Component rendering a form bound to the Server Action).
- `app/auth/signin/route.ts`, `app/auth/callback/route.ts` — Route Handlers.
- `app/actions.ts` — `decideAction` Server Action.
- `lib/oauth.test.ts` (or `node --test` file) — unit tests for the pure helpers.
- `metadata.json`, `README.md`.

## Environment & external wiring

- **Vercel project env:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Supabase dashboard (post-deploy, once the production URL is known):**
  - **Site URL** → the Vercel production origin (e.g. `https://oauth-consent-<you>.vercel.app`).
  - **Authorization Path** → `/oauth/consent`.
  - **`additional_redirect_urls`** → add `<vercel-origin>/auth/callback`.
- **Unchanged:** the GitHub OAuth app's Authorization callback URL stays `https://cznjlmqnxoaykcdzbjry.supabase.co/auth/v1/callback` (GitHub→Supabase), and the enabled GitHub provider.

## Cleanup of the abandoned Supabase Edge Function

- `supabase functions delete oauth-consent` (remove the live, broken function).
- Remove the `[functions.oauth-consent]` block from `supabase/config.toml` and the `supabase/functions/oauth-consent` copy (both gitignored).
- Delete the Deno consent files from `oauth-consent/` (`index.ts`, `decision.ts`, `consent_page.ts`, `deno.json`, `deno.lock`, `*_test.ts`) — replaced by the Next.js app.
- **Keep `scripts/deploy-function.sh`** — it is generic and still deploys `open-brain-mcp`.

## Error handling

| Condition | Behavior |
|-----------|----------|
| Missing `authorization_id` | Error page, no Supabase call |
| Not authenticated | Redirect to GitHub sign-in (preserving `authorization_id`) |
| `exchangeCodeForSession` fails | Error page with a link back to retry the consent URL |
| `getAuthorizationDetails` error / invalid id | "This authorization request has expired or is invalid" page |
| `getAuthorizationDetails` returns already-consented redirect | 307/302 to `redirect_url` |
| `approve`/`deny` upstream failure | Error page |
| Invalid decision value in the action | Error page, no Supabase call |

## Testing

- **Unit:** `lib/oauth.ts` pure helpers (`parseScopes`, `parseDecision`, `isConsentDetails`) via `node --test` or Vitest.
- **Integration (manual):** `vercel --prod` deploy, then the full claude.ai connector flow — authorize → GitHub login → consent → Approve → back to Claude → confirm `capture_thought` / `search_thoughts` work and rows are scoped to `user_id = auth.uid()`.

## Revised manual steps (replacing the Supabase-hosted consent prerequisites)

1. `vercel` (link/create the project) then `vercel --prod`; note the production URL.
2. Set `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the Vercel project env.
3. In Supabase: set Site URL = Vercel production origin, Authorization Path = `/oauth/consent`, add `<origin>/auth/callback` to `additional_redirect_urls`.
4. GitHub provider + GitHub OAuth app callback (`…/auth/v1/callback`) unchanged.

## Out of scope

- Custom domain (default `*.vercel.app` is sufficient).
- Multiple identity providers (GitHub only).
- Owner allow-listing (tenancy isolation is the control).
- Git-integration auto-deploys (CLI deploy for now).
- Styling beyond a clean, minimal consent screen.

## To verify during implementation

- `@supabase/ssr` server-client + `middleware.ts` session-refresh pattern against current Supabase Next.js SSR docs (the API is stable but confirm the exact `cookies()` adapter shape for Next 16).
- Server Action CSRF/Origin behavior on Vercel production (Next's `serverActions.allowedOrigins` may need the Vercel domain if the default Origin check is too strict).
- That `auth.uid()` resolves from the OAuth-server-issued token (carry-over from the resource-server work; confirm in the live e2e).
