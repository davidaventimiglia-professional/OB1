# OAuth Documentation & Setup Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document the OAuth 2.1 feature so a future user — or their AI agent — can stand it up on an existing Open Brain, capturing the exact setup order and the gotchas discovered during the build.

**Architecture:** Docs only (no code/deploy changes). New centerpiece `docs/oauth-setup.md` (agent-runnable, OAuth-upgrade scope) + targeted updates to `docs/auth.md`, `docs/04-ai-assisted-setup.md`, `docs/03-faq.md`. Fully generalized with placeholders — no real project values or secrets.

**Tech Stack:** Markdown. Verification via `grep` (no leaked specifics/secrets), cross-link checks, and a read-through ordering check.

**Spec:** `docs/superpowers/specs/2026-06-17-oauth-documentation-design.md`

---

## File Structure

- **Create** `docs/oauth-setup.md` — the agent-runnable OAuth upgrade guide (centerpiece).
- **Modify** `docs/auth.md` — why-intro, correct consent-page sections to Vercel, note `client_secret_post`, link to the setup guide.
- **Modify** `docs/04-ai-assisted-setup.md` — add an "Adding OAuth" pointer section.
- **Modify** `docs/03-faq.md` — add three OAuth Q&A entries.

## Canonical facts (use verbatim; placeholders, never real values)

These are the exact, verified values/commands the docs must use. Real project specifics
(`cznjlmqnxoaykcdzbjry`, `oauth-consent-sage`, any `sb_secret_…`, client_id `948c6405-…`)
must NOT appear — use the placeholders below.

- MCP server URL: `https://<project-ref>.supabase.co/functions/v1/open-brain-mcp`
- `OAUTH_ISSUER` = `https://<project-ref>.supabase.co/auth/v1`
- `OAUTH_RESOURCE` = `https://<project-ref>.supabase.co/functions/v1/open-brain-mcp`
- `OAUTH_CLIENT_ID` = the OAuth-Apps **client_id UUID**
- Claude (hosted) redirect URI: `https://claude.ai/api/mcp/auth_callback`
- GitHub OAuth app callback: `https://<project-ref>.supabase.co/auth/v1/callback`
- Consent app (Vercel): Site URL = `<vercel-origin>`, Authorization Path = `/oauth/consent`,
  redirect allow-list adds `<vercel-origin>/auth/callback`
- Vercel env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the **publishable** key)
- OAuth client: `client_type: confidential`, **`token_endpoint_auth_method: client_secret_post`**
- Deploy commands: `scripts/deploy-function.sh open-brain-mcp ./server` (resource server),
  `vercel --prod` (consent app)
- RLS migration: `schemas/oauth-rls`

---

### Task 1: Write `docs/oauth-setup.md` (centerpiece)

**Files:**
- Create: `docs/oauth-setup.md`

- [ ] **Step 1: Write the guide with these exact sections and content**

Use this section structure. Prose is the writer's craft, but every command/URL/value below
must appear exactly, and gotchas must be stated **before** the step that triggers them.

1. **Title + one-paragraph "What this adds & why"** — converts `open-brain-mcp` from a shared
   `x-brain-key` static secret to per-user OAuth 2.1 (each user a tenant; RLS by `auth.uid()`).
   Link to `docs/auth.md` for architecture and `docs/01-getting-started.md` for the base build.
2. **Prerequisites** — working base Open Brain (link `01-getting-started.md`); Supabase project
   with CLI linked; Vercel account + CLI (authenticated); a GitHub account; claude.ai.
3. **The moving parts** — bullet map: resource server (`open-brain-mcp`), RLS schema
   (`schemas/oauth-rls`), consent app (`oauth-consent/` on Vercel), GitHub identity provider,
   the OAuth client (represents Claude), the claude.ai connector. Note the **three distinct
   clients/callbacks** up front (this is the #1 confusion):
   - OAuth client (`OAUTH_CLIENT_ID`, a UUID from Authentication → OAuth Apps) — represents Claude.
   - GitHub OAuth app (user login) — callback `https://<project-ref>.supabase.co/auth/v1/callback`.
   - Consent app user-login return — `<vercel-origin>/auth/callback`.
4. **AI-does vs you-click** — AI: SQL migration, CLI deploys, edits, secret-setting, curl checks.
   You: Supabase dashboard (OAuth Server, providers, OAuth Apps, URL config), GitHub OAuth app,
   Vercel env, claude.ai connector.
5. **Ordered steps** (this exact order — it's the dependency order that works):
   1. **Apply the RLS-by-user migration** — `schemas/oauth-rls` (adds `user_id` defaulting to
      `auth.uid()`, RLS policies, per-user dedup). Apply via `supabase db push` or SQL Editor.
   2. **Deploy the consent app to Vercel** — from `oauth-consent/`: `vercel --prod`. Set
      `NEXT_PUBLIC_SUPABASE_URL` = `https://<project-ref>.supabase.co` and
      `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the **publishable** key in the Vercel project; record the
      production origin as `<vercel-origin>`.
   3. **Enable Supabase OAuth Server** (Authentication → OAuth Server), **DCR off**; set
      **Site URL** = `<vercel-origin>`, **Authorization Path** = `/oauth/consent`; add
      `<vercel-origin>/auth/callback` to **Redirect URLs** (`additional_redirect_urls`).
   4. **Enable the GitHub provider** (Authentication → Providers → GitHub): register a GitHub
      OAuth app with callback `https://<project-ref>.supabase.co/auth/v1/callback`; paste its
      id/secret into Supabase. (Leave "Enable Device Flow" off.)
   5. **Register the OAuth client** (Authentication → OAuth Apps → New): `client_type:
      confidential`, **`token_endpoint_auth_method: client_secret_post`**, redirect URI
      `https://claude.ai/api/mcp/auth_callback`. Capture the **client_id (UUID)** and secret.
   6. **Set resource-server secrets + deploy** —
      `supabase secrets set OAUTH_ISSUER="https://<project-ref>.supabase.co/auth/v1" OAUTH_RESOURCE="https://<project-ref>.supabase.co/functions/v1/open-brain-mcp" OAUTH_CLIENT_ID="<client-id-uuid>"`,
      then `scripts/deploy-function.sh open-brain-mcp ./server`.
   7. **Add the claude.ai connector** — MCP URL `https://<project-ref>.supabase.co/functions/v1/open-brain-mcp`;
      Advanced settings → client_id (UUID) + client_secret. Connect.
   8. **Verify** — discovery returns JSON:
      `curl -s https://<project-ref>.supabase.co/functions/v1/open-brain-mcp/.well-known/oauth-protected-resource`;
      no-token POST → 401 + `WWW-Authenticate`; then a `capture_thought` + `search_thoughts`
      round-trip in claude.ai.
6. **Common gotchas** — each as a short subsection:
   - Supabase Edge delivers paths as `/<slug>/…` (discovery matched by suffix).
   - HTML on the default `*.supabase.co` domain is rewritten to `text/plain` + `sandbox` CSP →
     the consent UI must be on Vercel (or a Pro custom domain).
   - **`client_secret_basic` (Supabase confidential default) vs Claude's `client_secret_post`** —
     mismatch → `invalid_credentials`; set the client to `client_secret_post`.
   - The three clients/callbacks (don't cross them).
   - Redirect URIs are exact-match (no trailing slash).
   - claude.ai connectors aren't editable — remove + re-add to change values.
   - Rotate any secret that gets exposed; the function reads none of the client secrets.
7. **Troubleshooting by symptom** —
   - `oauth_client_not_found` / "invalid client_id format" → the client_id must be the OAuth-Apps
     **UUID**, not the GitHub app id or a project key.
   - `invalid_credentials` at `/oauth/token` → auth-method mismatch (set `client_secret_post`) or
     wrong secret. Read **Supabase Dashboard → Logs** for the `/oauth/token` error code, and
     isolate with a direct `curl` to the token endpoint (POST body and `-u` basic variants) to
     tell a method mismatch from a bad secret.

- [ ] **Step 2: Verify no real project values or secrets leaked**

Run:
```bash
cd /home/david-a-ventimiglia/Work/OB1
grep -nE "cznjlmqnxoaykcdzbjry|oauth-consent-sage|sb_secret_|948c6405" docs/oauth-setup.md && echo "LEAK — fix" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Verify referenced paths exist**

Run:
```bash
for p in schemas/oauth-rls oauth-consent server scripts/deploy-function.sh docs/auth.md docs/01-getting-started.md; do test -e "$p" && echo "ok $p" || echo "MISSING $p"; done
```
Expected: all `ok`.

- [ ] **Step 4: Commit**

```bash
git add docs/oauth-setup.md
git commit -m "[docs] add agent-runnable OAuth setup guide (oauth-setup.md)"
```

---

### Task 2: Update `docs/auth.md`

**Files:**
- Modify: `docs/auth.md`

- [ ] **Step 1: Make these edits**
  - Add a short **"Why OAuth / what changed from `x-brain-key`"** paragraph near the top
    (Overview): the static shared key is replaced by per-user OAuth 2.1; tenancy is the user.
  - Correct any text implying the **consent page is a Supabase Edge Function** — it is a
    **Next.js app on Vercel** (`oauth-consent/`). Specifically the consent-related parts of the
    "Manual prerequisites" and any discovery/flow description: Site URL = the Vercel origin,
    Authorization Path = `/oauth/consent`, redirect allow-list = `<vercel-origin>/auth/callback`.
  - In the token-model / prerequisites, note the client must use
    **`token_endpoint_auth_method: client_secret_post`** (Supabase confidential clients default
    to `client_secret_basic`, which Claude does not use).
  - Add a top-of-file link: "For step-by-step setup, see `oauth-setup.md`."

- [ ] **Step 2: Verify no leaks + the cross-link**

Run:
```bash
grep -nE "cznjlmqnxoaykcdzbjry|oauth-consent-sage|sb_secret_|948c6405" docs/auth.md && echo "LEAK — fix" || echo "clean"
grep -q "oauth-setup.md" docs/auth.md && echo "link ok" || echo "MISSING link"
grep -niE "client_secret_post" docs/auth.md >/dev/null && echo "auth-method noted" || echo "MISSING auth-method note"
```
Expected: `clean`, `link ok`, `auth-method noted`.

- [ ] **Step 3: Commit**

```bash
git add docs/auth.md
git commit -m "[docs] auth.md: Vercel consent reality, client_secret_post, why-OAuth intro, setup link"
```

---

### Task 3: Update `docs/04-ai-assisted-setup.md`

**Files:**
- Modify: `docs/04-ai-assisted-setup.md`

- [ ] **Step 1: Add an "Adding OAuth" section**

Add a short section near the end: to upgrade an existing Open Brain to per-user OAuth, point
your AI tool at `docs/oauth-setup.md` and tell it to walk you through it — it handles the SQL
migration, CLI deploys (Supabase + Vercel), and curl verification; you handle the Supabase
dashboard, the GitHub OAuth app, Vercel env, and the claude.ai connector. Note the one thing AIs
reliably trip on: the `client_secret_basic` vs `client_secret_post` mismatch (point to the
setup guide's gotchas).

- [ ] **Step 2: Verify the pointer + no leaks**

Run:
```bash
grep -q "oauth-setup.md" docs/04-ai-assisted-setup.md && echo "pointer ok" || echo "MISSING pointer"
grep -nE "cznjlmqnxoaykcdzbjry|oauth-consent-sage|sb_secret_|948c6405" docs/04-ai-assisted-setup.md && echo "LEAK — fix" || echo "clean"
```
Expected: `pointer ok`, `clean`.

- [ ] **Step 3: Commit**

```bash
git add docs/04-ai-assisted-setup.md
git commit -m "[docs] 04-ai-assisted-setup: add 'Adding OAuth' pointer to oauth-setup.md"
```

---

### Task 4: Update `docs/03-faq.md`

**Files:**
- Modify: `docs/03-faq.md`

- [ ] **Step 1: Add three Q&A entries** (match the file's existing Q/A formatting)
  - **"Do I still use `x-brain-key`?"** — No. The MCP server is now an OAuth 2.1 resource server;
    clients authenticate with OAuth tokens. See `oauth-setup.md`.
  - **"Why is the consent page on Vercel instead of Supabase?"** — Supabase rewrites
    Edge-Function HTML on the default domain to `text/plain` + a `sandbox` CSP (real HTML needs a
    Pro custom domain), which breaks an interactive consent screen; Vercel serves it cleanly.
  - **"Connecting fails with `invalid_credentials` — why?"** — Almost always the OAuth client's
    `token_endpoint_auth_method` is `client_secret_basic` (Supabase default) but Claude uses
    `client_secret_post`; set it to `client_secret_post`. See `oauth-setup.md` troubleshooting.

- [ ] **Step 2: Verify entries + no leaks**

Run:
```bash
grep -qiE "x-brain-key|invalid_credentials|consent page" docs/03-faq.md && echo "entries ok" || echo "MISSING entries"
grep -nE "cznjlmqnxoaykcdzbjry|oauth-consent-sage|sb_secret_|948c6405" docs/03-faq.md && echo "LEAK — fix" || echo "clean"
```
Expected: `entries ok`, `clean`.

- [ ] **Step 3: Commit**

```bash
git add docs/03-faq.md
git commit -m "[docs] 03-faq: OAuth entries (x-brain-key retired, Vercel consent, invalid_credentials)"
```

---

### Task 5: Final cross-doc verification

**Files:** none (verification + push).

- [ ] **Step 1: Repo-wide leak scan across the touched docs**

Run:
```bash
cd /home/david-a-ventimiglia/Work/OB1
grep -rnE "cznjlmqnxoaykcdzbjry|oauth-consent-sage|sb_secret_|948c6405" docs/oauth-setup.md docs/auth.md docs/04-ai-assisted-setup.md docs/03-faq.md && echo "LEAK — fix" || echo "clean across all"
```
Expected: `clean across all`.

- [ ] **Step 2: Cross-links resolve**

Run:
```bash
grep -q "oauth-setup.md" docs/auth.md docs/04-ai-assisted-setup.md && echo "inbound links ok" || echo "MISSING inbound links"
grep -qE "auth\.md|01-getting-started\.md" docs/oauth-setup.md && echo "outbound links ok" || echo "MISSING outbound links"
```
Expected: `inbound links ok`, `outbound links ok`.

- [ ] **Step 3: Read-through ordering check (manual)**

Read `docs/oauth-setup.md` top to bottom and confirm: the steps are in the order that actually
works (consent app deployed before Supabase Site URL is wired to it; OAuth client registered
with `client_secret_post` before the connector is added), and each gotcha is stated before the
step it affects.

- [ ] **Step 4: Push**

```bash
git push
```

---

## Self-Review

**Spec coverage:**
- Centerpiece `docs/oauth-setup.md` (agent-runnable, upgrade scope, all 7 sections) → Task 1. ✓
- `docs/auth.md` update (why-intro, Vercel consent, `client_secret_post`, link) → Task 2. ✓
- `docs/04-ai-assisted-setup.md` pointer → Task 3. ✓
- `docs/03-faq.md` entries → Task 4. ✓
- Generalization / no leaked specifics or secrets → Tasks 1–5 grep checks. ✓
- Cross-links resolve → Task 5. ✓
- Ordering/gotcha-before-step bench check → Task 5 Step 3. ✓
- Out of scope (no code changes, no from-scratch dup, no companion prompt, nothing upstream) →
  respected; all tasks touch only `docs/`. ✓

**Placeholder scan:** The `<project-ref>` / `<vercel-origin>` / `<client-id-uuid>` tokens are
intentional doc placeholders, not plan gaps. No "TBD/TODO". Every step has concrete content or
an exact command with expected output.

**Consistency:** File paths, env var names (`OAUTH_ISSUER`/`OAUTH_RESOURCE`/`OAUTH_CLIENT_ID`,
`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`), the `client_secret_post` requirement,
the Claude redirect URI, and the deploy commands match across all tasks and the canonical-facts
block.
