# OAuth 2.1 Setup for Open Brain

This guide upgrades an existing Open Brain installation from a shared static key (`x-brain-key` / `MCP_ACCESS_KEY`) to a per-user OAuth 2.1 authorization flow. After this change, each person who connects to your `open-brain-mcp` server authenticates as themselves — Supabase issues them a personal JWT, and Row-Level Security (RLS) scopes every query to their own rows. There is no shared secret in the URL and no single credential that grants access to everyone's thoughts.

The architecture is described in full in [auth.md](auth.md). Start with [01-getting-started.md](01-getting-started.md) if you haven't built your base Open Brain yet.

---

## Prerequisites

- A working base Open Brain (see [01-getting-started.md](01-getting-started.md))
- The Supabase CLI installed and linked to your project (`supabase link --project-ref <project-ref>`)
- A Vercel account and the Vercel CLI installed and authenticated (`vercel login`)
- A GitHub account (used as the identity provider on the consent page)
- A claude.ai account (to add the connector)

---

## The Moving Parts

Before you touch anything, get this picture in your head. There are six components that all talk to each other, and three of them involve something called a "client" — each one is different.

| Component | What it is | Where it lives |
|---|---|---|
| **Resource server** (`open-brain-mcp`) | The MCP Edge Function that verifies tokens and serves your tools | Supabase Edge Functions |
| **Authorization server** | Supabase Auth — issues JWTs, hosts the consent flow | Supabase Auth |
| **RLS schema** (`schemas/oauth-rls`) | Migration that adds `user_id` + per-user policies to `thoughts` | Applied to your Supabase DB |
| **Consent app** (`oauth-consent/`) | A Next.js app that hosts the approve/deny screen | Vercel |
| **GitHub identity provider** | Signs users in before they see the consent screen | GitHub + Supabase dashboard |
| **claude.ai connector** | How Claude connects to your MCP server over OAuth | claude.ai Settings |

### The three distinct clients and callbacks — read this first

This is the #1 source of confusion. There are three separate OAuth/auth "clients," each with its own callback URL. Mixing them up causes silent failures.

1. **The OAuth client** (`OAUTH_CLIENT_ID`, a UUID from Authentication → OAuth Apps in the Supabase dashboard) — this represents Claude. Its redirect URI is `https://claude.ai/api/mcp/auth_callback`.
2. **The GitHub OAuth app** (user login into the consent page) — its Authorization callback URL is `https://<project-ref>.supabase.co/auth/v1/callback`.
3. **The consent app user-login return** — the URL the consent app redirects to after GitHub login completes, which is `<vercel-origin>/auth/callback`. This goes in Supabase's redirect allow-list.

Do not cross these. Each one belongs to a different layer of the flow.

---

## What the AI Does vs. What You Click

An AI coding tool can handle the mechanical parts of this setup. Some steps require clicking through web dashboards that require a human.

**AI (or CLI in your terminal):**
- Applying the SQL migration via `supabase db push`
- Running `vercel --prod` from `oauth-consent/`
- Setting Supabase function secrets with `supabase secrets set`
- Deploying the resource server with `scripts/deploy-function.sh`
- Running `curl` checks to verify discovery and the 401 challenge

**You (dashboard clicks):**
- Supabase dashboard: enabling OAuth Server, setting Site URL / Authorization Path, adding redirect URLs
- Supabase dashboard: enabling the GitHub provider
- Supabase dashboard: registering the OAuth client (Authentication → OAuth Apps)
- GitHub: creating the GitHub OAuth app
- Vercel: setting environment variables in the project settings
- claude.ai: adding the custom connector

---

## Steps

Work through these in order. Each step depends on the one before it.

### Step 1 — Apply the RLS-by-user migration

The migration in `schemas/oauth-rls` adds a `user_id uuid` column (indexed, FK to `auth.users`, defaulting to `auth.uid()`) to the `thoughts` table, replaces the existing RLS policies with four per-user policies for the `authenticated` role (SELECT / INSERT / UPDATE / DELETE), and redefines `upsert_thought` and `match_thoughts` as `SECURITY INVOKER` so they stamp and filter by `user_id`.

> **Legacy rows.** Any thoughts created before this migration have `user_id IS NULL`. They will be invisible to OAuth clients until backfilled with a real `user_id`. They remain accessible to the service role.

Run from your repo root:

```bash
supabase db push
```

Or open the Supabase dashboard → SQL Editor and paste the contents of `schemas/oauth-rls` directly.

### Step 2 — Deploy the consent app to Vercel

The consent page must live on Vercel (not as a Supabase Edge Function) because Supabase rewrites Edge Function HTML responses on the default `*.supabase.co` domain to `text/plain` with a `sandbox` CSP. That breaks an interactive page. Vercel serves it correctly.

From the `oauth-consent/` directory:

```bash
cd oauth-consent
vercel --prod
```

Once the deployment completes, note the production URL. This is your `<vercel-origin>` (e.g. `https://your-app.vercel.app`).

Then in the Vercel project's settings → Environment Variables, set:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase **publishable** (anon) key — not the service role key |

Redeploy after setting these (`vercel --prod` again) if the variables weren't set before the first deploy.

### Step 3 — Enable the Supabase OAuth Server

In the Supabase dashboard → Authentication → OAuth Server:

- Enable the OAuth Server
- Set **Dynamic Client Registration** to **OFF**
- Set **Site URL** to `<vercel-origin>` (your Vercel production origin from Step 2)
- Set **Authorization Path** to `/oauth/consent`

This makes the consent URL `<vercel-origin>/oauth/consent`, which is where Supabase Auth will redirect users during the authorization-code flow.

Still in Authentication → URL Configuration, add `<vercel-origin>/auth/callback` to the **Redirect URLs** allow-list. This is the user-login return URL the consent app passes to `signInWithOAuth` — it is distinct from Claude's redirect URI (that comes in Step 5).

### Step 4 — Enable the GitHub identity provider

The consent page signs the user in with GitHub before showing the approve/deny screen. You need a GitHub OAuth app wired to Supabase.

**Create the GitHub OAuth app:**

1. Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Set the **Authorization callback URL** to exactly:
   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```
3. Note the **Client ID** and generate a **Client Secret**

**Wire it to Supabase:**

In the Supabase dashboard → Authentication → Providers → GitHub:

- Enable the GitHub provider
- Paste the GitHub OAuth app's Client ID and Client Secret
- Leave "Enable Device Flow" off
- Save

### Step 5 — Register the OAuth client

This registers Claude as a client with Supabase Auth. This is the `OAUTH_CLIENT_ID` the resource server checks.

In the Supabase dashboard → Authentication → OAuth Apps → New:

| Field | Value |
|---|---|
| Client type | `confidential` |
| Token endpoint auth method | `client_secret_post` |
| Redirect URI | `https://claude.ai/api/mcp/auth_callback` |

> **`client_secret_post` is required.** Supabase defaults confidential clients to `client_secret_basic` (HTTP Basic auth on the token endpoint). Claude sends credentials in the POST body (`client_secret_post`). If these don't match, every token exchange fails with `invalid_credentials`. Set this field explicitly before saving.

After saving, Supabase shows you:
- A **client_id** — this is a UUID (e.g. `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). This is `<client-id-uuid>`.
- A **client_secret** — copy it now; you won't see it again.

### Step 6 — Set resource-server secrets and deploy

Set the three OAuth secrets the resource server needs:

```bash
supabase secrets set \
  OAUTH_ISSUER="https://<project-ref>.supabase.co/auth/v1" \
  OAUTH_RESOURCE="https://<project-ref>.supabase.co/functions/v1/open-brain-mcp" \
  OAUTH_CLIENT_ID="<client-id-uuid>"
```

Then deploy the resource server:

```bash
scripts/deploy-function.sh open-brain-mcp ./server
```

The function is deployed with `--no-verify-jwt` (gateway JWT verification must be off — see [auth.md](auth.md) for why). The `client_secret` from Step 5 is **not** set as a function secret; the resource server only verifies access tokens and never uses the client secret.

### Step 7 — Add the claude.ai connector

In claude.ai → Settings → Connectors → Add custom connector:

- **MCP Server URL:** `https://<project-ref>.supabase.co/functions/v1/open-brain-mcp`
- Under **Advanced settings:**
  - **Client ID:** `<client-id-uuid>` (the UUID from Step 5 — not the GitHub app id, not an API key)
  - **Client Secret:** the client secret from Step 5

Click Connect. Claude will open the consent page, you'll sign in with GitHub, approve access, and the connector will complete the authorization-code flow.

> **Connectors are not editable in claude.ai.** If you need to change the URL, client ID, or secret, remove the connector and add it again.

### Step 8 — Verify

Run these checks in order:

**Discovery endpoint responds:**
```bash
curl -s https://<project-ref>.supabase.co/functions/v1/open-brain-mcp/.well-known/oauth-protected-resource | jq .
```
Expected: JSON with `resource` and `authorization_servers` fields.

**No-token request returns 401 with challenge:**
```bash
curl -i -X POST https://<project-ref>.supabase.co/functions/v1/open-brain-mcp
```
Expected: HTTP `401` with a `WWW-Authenticate: Bearer resource_metadata="…"` header.

**End-to-end round-trip:**
In claude.ai, run a `capture_thought` followed by a `search_thoughts`. Both should succeed and return results scoped to your user.

---

## Common Gotchas

### Edge Function path handling
Supabase Edge Functions receive request paths as `/<function-slug>/…`. The resource server's discovery handler matches by path suffix (e.g. `/.well-known/oauth-protected-resource`), not an absolute path. This is expected behavior — don't add the slug manually to discovery URLs.

### HTML on `*.supabase.co` is rewritten
Supabase rewrites HTML responses from Edge Functions on the default domain to `text/plain` with a `sandbox` CSP. Real HTML requires a Pro custom domain on the Supabase side. This is why the consent UI lives on Vercel. Do not try to move it back to Supabase Edge Functions unless you have a Pro plan with a custom domain.

### `client_secret_post` vs. `client_secret_basic`
This is the most common failure mode. Supabase's default for confidential clients is `client_secret_basic` (credentials in the `Authorization: Basic …` header). Claude sends credentials in the POST body (`client_secret_post`). A mismatch causes `invalid_credentials` at `/oauth/token`. Set the client to `client_secret_post` when registering in Step 5.

### The three clients
Don't cross the three client/callback pairs described above. Common mistakes:
- Putting the GitHub OAuth app callback URL into the OAuth client redirect URI field (or vice versa)
- Entering the GitHub OAuth app's client ID as the `OAUTH_CLIENT_ID` (it should be the UUID from Authentication → OAuth Apps)
- Adding `https://claude.ai/api/mcp/auth_callback` to the redirect allow-list instead of `<vercel-origin>/auth/callback`

### Redirect URIs are matched exactly
Supabase matches redirect URIs by exact string. No trailing slash, no case differences, no HTTP vs. HTTPS substitution. If the URI registered with the OAuth client doesn't match character-for-character what Claude sends, the authorization will fail.

### Rotate any exposed secret
If a `client_secret`, `OAUTH_ISSUER` value, or any other credential is exposed, rotate it. The resource server reads none of the client secrets — it only needs `OAUTH_ISSUER`, `OAUTH_RESOURCE`, and `OAUTH_CLIENT_ID` as function secrets.

---

## Troubleshooting by Symptom

### `oauth_client_not_found` or "invalid client_id format"

The `client_id` must be the OAuth Apps **UUID** from the Supabase dashboard (Authentication → OAuth Apps). Common wrong values:
- The GitHub OAuth app's numeric client ID
- The Supabase project ref
- An anon or service-role API key

The UUID format is `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. If what you have doesn't look like that, you have the wrong value.

### `invalid_credentials` at `/oauth/token`

This means either the auth method is wrong or the secret is wrong. To isolate which:

Check the Supabase dashboard → Logs → Edge Functions for the `/oauth/token` error code first.

Then isolate with `curl`. Try the `client_secret_post` form (credentials in the body):

```bash
curl -s -X POST https://<project-ref>.supabase.co/auth/v1/token?grant_type=authorization_code \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=<client-id-uuid>&client_secret=<your-secret>&code=<code>&redirect_uri=https://claude.ai/api/mcp/auth_callback"
```

And the `client_secret_basic` form (credentials in the header):

```bash
curl -s -X POST https://<project-ref>.supabase.co/auth/v1/token?grant_type=authorization_code \
  -u "<client-id-uuid>:<your-secret>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=<code>&redirect_uri=https://claude.ai/api/mcp/auth_callback"
```

If one form succeeds and the other fails, that tells you which auth method Supabase expects for this client — and it should be `client_secret_post`. If both fail, the secret itself is wrong; regenerate it in the dashboard (Authentication → OAuth Apps → your client → Rotate secret) and re-enter it in the claude.ai connector (remove and re-add the connector).
