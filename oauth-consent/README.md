# OAuth Consent App (Vercel)

The authorization-server-side **consent page** for Open Brain's OAuth 2.1 setup,
hosted on **Vercel** (Next.js App Router). Supabase Auth redirects users here
(`Site URL + Authorization Path`) with an `?authorization_id=…`; this app logs
them in via GitHub and records their approve/deny decision.

> Why Vercel: Supabase rewrites HTML served from Edge Functions on the default
> `*.supabase.co` domain to `text/plain` with a `sandbox` CSP (real HTML needs a
> Pro custom domain), which breaks an interactive consent page. Vercel renders
> HTML on its default domain. Supabase remains the OAuth authorization server,
> GitHub identity provider, JWKS issuer, and RLS data backend.

## Flow

1. `GET /oauth/consent?authorization_id=…` — if not signed in, redirects to
   `/auth/signin`, which starts GitHub OAuth (PKCE) via `@supabase/ssr`.
2. GitHub returns to `/auth/callback?code=…`; the app exchanges it for a session,
   then returns to `/oauth/consent`, calls `auth.oauth.getAuthorizationDetails`,
   and renders the consent screen (client name + scopes, Approve / Deny).
3. Approve/Deny posts to a Next **Server Action** (built-in CSRF protection),
   which calls `approveAuthorization` / `denyAuthorization`
   (`skipBrowserRedirect: true`) and redirects back to the OAuth client.

Any authenticated user may consent; per-user RLS (`user_id = auth.uid()`, see
`schemas/oauth-rls/`) isolates each tenant's brain.

## Develop

```bash
npm install
npm run test     # unit tests for lib/oauth.ts
npm run dev      # local dev server
```

## Deploy (Vercel CLI)

```bash
vercel          # first run links/creates the project
vercel --prod   # production deploy; note the production URL
```

Set in the Vercel project env: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## Supabase configuration

- **Site URL** = the Vercel production origin.
- **Authorization Path** = `/oauth/consent`.
- Add `<vercel-origin>/auth/callback` to `additional_redirect_urls`.
- GitHub provider enabled; the GitHub OAuth app's callback stays
  `https://<project-ref>.supabase.co/auth/v1/callback`.
