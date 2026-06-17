# OAuth Feature Documentation & Setup Guidance — Design

**Date:** 2026-06-17
**Branch:** `feat/oauth-resource-server`
**Status:** Approved design, pending implementation plan

## Context

The OAuth 2.1 cutover is built and verified end-to-end (resource server with per-user
RLS, a Vercel-hosted consent app, GitHub login, live claude.ai connector). But it is
effectively undocumented for anyone other than us: there's a technical reference
(`docs/auth.md`) that predates the final Vercel architecture, and the actual end-to-end
*setup* — the ordered steps and the many non-obvious gotchas we discovered — exists only
in this session's history and a private memory note. Before this can be adopted by others
(or proposed upstream), it needs documentation that lets a future user — or, per the repo's
established "AI-assisted setup" philosophy, **their AI agent** — stand the whole thing up.

The repo already establishes the conventions to extend: `docs/01-getting-started.md` (base
setup), `docs/02-companion-prompts.md`, `docs/04-ai-assisted-setup.md` (point your AI at the
repo and have it execute the guide), `docs/03-faq.md`, and `docs/auth.md` (OAuth reference).

This is **documentation only** — no code or deployment changes.

## Locked decisions

| Decision | Choice |
|----------|--------|
| Centerpiece | An **agent-runnable setup guide** (a human or their AI can execute it), matching `04-ai-assisted-setup`'s philosophy |
| Scope | **OAuth upgrade on an existing Open Brain** — assumes the base (thoughts table + `open-brain-mcp`) from `01-getting-started`; covers only the OAuth delta |
| Supporting scope | "Standard": update `docs/auth.md`, add a pointer in `04-ai-assisted-setup.md`, add FAQ entries |
| Centerpiece location | New `docs/oauth-setup.md` (topic-named, pairs with `docs/auth.md`) |
| Generalization | Placeholders (`<project-ref>`, `<vercel-origin>`, `<client-id>`); **no hardcoding** of our `cznjlmqnxoaykcdzbjry` / `oauth-consent-sage` specifics |

## Deliverables

### 1. `docs/oauth-setup.md` (new — the centerpiece)

An ordered, agent-executable walkthrough to add OAuth to an existing Open Brain.
Sections:

1. **What this adds & why** — converts the MCP server from a shared `x-brain-key`
   static secret into per-user OAuth 2.1 (each user a tenant, RLS by `auth.uid()`).
   One paragraph; link to `docs/auth.md` for the architecture.
2. **Prerequisites** — working base Open Brain (link `01-getting-started.md`), Supabase
   project with the CLI linked, a Vercel account + CLI, a GitHub account, claude.ai.
3. **The moving parts** — a short map: resource server (`open-brain-mcp`), RLS schema
   (`schemas/oauth-rls`), consent app (`oauth-consent/` on Vercel), GitHub identity
   provider, the OAuth client (Claude), the claude.ai connector.
4. **AI-does vs you-click** — what an agent handles (SQL, CLI, deploys, edits) vs the
   dashboard/account actions a human must do (mirrors `04-ai-assisted-setup.md`).
5. **Ordered steps** (in the dependency order we validated):
   1. Apply the RLS-by-user migration (`schemas/oauth-rls`).
   2. Deploy the consent app to Vercel (`vercel --prod`); set `NEXT_PUBLIC_SUPABASE_URL`
      + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key); capture the production origin.
   3. Enable Supabase **OAuth Server** (DCR off); set **Site URL** = the Vercel origin,
      **Authorization Path** = `/oauth/consent`, and add `<vercel-origin>/auth/callback`
      to `additional_redirect_urls`.
   4. Enable the **GitHub** auth provider (GitHub OAuth app; callback
      `https://<project-ref>.supabase.co/auth/v1/callback`).
   5. Register the **OAuth client** (Authentication → OAuth Apps): `client_type:
      confidential`, **`token_endpoint_auth_method: client_secret_post`**, redirect URI
      `https://claude.ai/api/mcp/auth_callback`; capture the `client_id` (UUID) + secret.
   6. Set resource-server secrets (`OAUTH_ISSUER`, `OAUTH_RESOURCE`, `OAUTH_CLIENT_ID`)
      and deploy the OAuth build of `open-brain-mcp` (`scripts/deploy-function.sh`).
   7. Add the **claude.ai connector** — MCP URL + Advanced settings client_id/secret —
      and connect.
   8. **Verify** — discovery JSON, the 401 + `WWW-Authenticate` challenge, and a
      `capture_thought` / `search_thoughts` round-trip.
6. **Common gotchas** — Supabase Edge path-prefix (`/<slug>/…`); HTML rewritten to
   `text/plain` + `sandbox` CSP on the default domain (→ Vercel); **`client_secret_basic`
   default vs Claude's `client_secret_post`**; the three clients/callbacks; exact-match
   redirect URIs; connector not editable (remove + re-add); rotating the secrets.
7. **Troubleshooting by symptom** — `oauth_client_not_found` / "invalid client_id format"
   (client_id must be the OAuth-Apps UUID) and `invalid_credentials` at `/oauth/token`
   (auth-method mismatch or wrong secret), each with the **Supabase Auth Logs** tip and
   the `/oauth/token` curl isolation test.

### 2. `docs/auth.md` (update)

- Add a short **"Why OAuth / what changed from `x-brain-key`"** intro.
- Correct the consent-page sections to the **Vercel Next.js** reality (it currently reads
  as if the consent page is a Supabase Edge Function).
- Note the **`token_endpoint_auth_method: client_secret_post`** requirement in the token
  model / prerequisites.
- Link to `docs/oauth-setup.md` for the step-by-step.

### 3. `docs/04-ai-assisted-setup.md` (update)

Add a short section: to add OAuth on top of a base Open Brain, point your AI at
`docs/oauth-setup.md` and have it walk you through (it handles SQL/CLI/deploys; you handle
the Supabase/Vercel/GitHub dashboards and the claude.ai connector).

### 4. `docs/03-faq.md` (update)

A few entries: "Do I still use `x-brain-key`?" (no — OAuth), "Why is the consent page on
Vercel instead of Supabase?", "Why does connecting fail with `invalid_credentials`?"
(point to the `client_secret_post` gotcha).

## Source material

The generalized content comes from: this session's verified setup sequence, the private
memory note `oauth-supabase-vercel-deploy-gotchas.md`, `docs/auth.md`, the three component
READMEs (`oauth-consent/`, `schemas/oauth-rls/`, `server/`), and `scripts/deploy-function.sh`.

## Out of scope

- Any code, schema, or deployment changes (docs only).
- A from-scratch guide that re-covers base Open Brain setup (link to `01` instead).
- A copy-paste companion prompt and `01` cross-links (those were the "Comprehensive" tier;
  deferred).
- Opening anything upstream to `NateBJones-Projects/OB1`.

## Verification

- Each placeholder (`<project-ref>`, `<vercel-origin>`, `<client-id>`) is consistent and
  carries no real project values (grep for `cznjlmqnxoaykcdzbjry` / `oauth-consent-sage` →
  zero hits in the committed docs).
- Cross-links resolve (`oauth-setup.md` ↔ `auth.md` ↔ `04` ↔ `01`).
- Markdown lints clean; metadata/`CONTRIBUTING` conventions respected.
- Bench check: a reader (or agent) following `docs/oauth-setup.md` top to bottom hits the
  steps in the order that actually works, with each gotcha flagged *before* the step that
  triggers it.
