# OAuth Consent Edge Function

The authorization-server-side **consent page** for Open Brain's OAuth 2.1 setup.
Supabase Auth redirects users here (`Site URL + Authorization Path`) with an
`?authorization_id=...`; this function logs them in via GitHub and records their
approve/deny decision.

## Flow

1. `GET /functions/v1/oauth-consent?authorization_id=…` — if not signed in, starts
   GitHub OAuth (PKCE) via `@supabase/ssr` and shows a "Continue with GitHub" page.
2. GitHub returns to the same route with `?code=…`; the function exchanges it for a
   session, then calls `auth.oauth.getAuthorizationDetails` and renders the consent
   screen (client name + requested scopes, Approve / Deny).
3. `POST /functions/v1/oauth-consent/decision` — verifies a double-submit CSRF token,
   calls `approveAuthorization` / `denyAuthorization` (`skipBrowserRedirect: true`),
   and 302-redirects back to the OAuth client.

Any authenticated user may consent; per-user RLS (`user_id = auth.uid()`, see
`schemas/oauth-rls/`) isolates each tenant's brain, so a new sign-up gets an empty
brain rather than access to anyone else's.

## Deploy

Symlinked into the Supabase functions tree and deployed with `verify_jwt = false`:

```bash
ln -s ../../oauth-consent supabase/functions/oauth-consent
supabase functions deploy oauth-consent
```

## Required configuration

- Env/secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- Dashboard: **Site URL** = your project URL; **Authorization Path** =
  `/functions/v1/oauth-consent`.
- Enable the **GitHub** auth provider.
- Add `<project-url>/functions/v1/oauth-consent` to the redirect allow-list
  (`additional_redirect_urls`).

## Test

```bash
cd oauth-consent && deno test --allow-net --allow-env --allow-read
```
