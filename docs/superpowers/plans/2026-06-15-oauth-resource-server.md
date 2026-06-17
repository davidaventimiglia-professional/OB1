# OAuth 2.1 Resource Server for open-brain MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the open-brain MCP Edge Function into a spec-compliant OAuth 2.1 *resource server* that drives OAuth discovery, validates Supabase-issued access tokens, scopes data via RLS keyed on `client_id`, and retires the static `x-brain-key`.

**Architecture:** Keep the single deployed entrypoint `server/index.ts`, but extract auth concerns into a sibling, unit-testable module `server/auth.ts` (no `Deno.serve`, pure/injectable functions). A Hono middleware serves the two `.well-known` discovery documents publicly, returns `401 + WWW-Authenticate` on missing/invalid tokens, and on success attaches a **per-request Supabase client built from the caller's JWT** so PostgREST/RLS enforces access. `buildServer()` is parameterized to take that per-request client instead of closing over the module-level service-role client. JWKS is fetched from the discovered `jwks_uri` and cached via `jose`'s `createRemoteJWKSet` (handles TTL + refresh-on-unknown-kid). Audience binding is enforced via the token's `client_id` claim (== our one registered client) since Supabase's default `aud` is the generic `"authenticated"`; RLS keyed on `(auth.jwt() ->> 'client_id')` is the real data boundary.

**Tech Stack:** Deno, Hono, `@modelcontextprotocol/sdk`, `@hono/mcp`, `@supabase/supabase-js`, `jose` (new), `zod`. Supabase Auth OAuth 2.1 server. Tests: `deno test`.

---

## Spec facts that drive this design (verified against live docs 2026-06-15)

- **MCP auth spec (2025-06-18):** RS **MUST** implement RFC 9728 Protected Resource Metadata; on 401 **MUST** send `WWW-Authenticate` per RFC 9728 §5.1 pointing at the resource-metadata URL; the PRM document **MUST** include `authorization_servers` with ≥1 entry. RS **MUST** validate the token is intended for it (audience), reject invalid/expired with **401**, scope errors with **403**. Clients send `Authorization: Bearer` on every request; tokens **MUST NOT** be in the URI query string.
- **Supabase OAuth server:** Access tokens are **JWTs** with `"role": "authenticated"`; default `"aud": "authenticated"` (generic — *not* the resource URI); they carry a **`client_id`** claim (the OAuth client UUID). RLS keys off `(auth.jwt() ->> 'client_id')`. Discovery: AS metadata at `https://<ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1`; JWKS at the metadata's `jwks_uri`. `verify_jwt=false` makes the *function* own auth (gateway won't shadow discovery with its own 401).
- **Residual risk (document, don't silently accept):** because default `aud` is generic, strict per-resource audience binding isn't met out of the box. We enforce `client_id == OAUTH_CLIENT_ID` + RLS as the boundary. Optional hardening (manual prereq): a Custom Access Token Hook setting `aud` to the resource URI.

## Manual prerequisites (OUT OF SCOPE — document in PR, do not automate)

1. Enable Authentication → OAuth Server in the Supabase dashboard; **dynamic client registration OFF** (`allow_dynamic_registration = false`).
2. Build/host the authorization + consent page at Site URL + `/oauth/consent` (uses `supabase.auth.oauth.getAuthorizationDetails` / `approveAuthorization` / `denyAuthorization`). **External prerequisite — not hosted in this repo.**
3. Register the pre-registered OAuth client (Authentication → OAuth Apps → Add client); capture `client_id` / `client_secret`.
4. Obtain Claude's **exact** OAuth callback/redirect URI from the claude.ai connector dialog and register it verbatim (exact-match enforced — most common failure).
5. Set Supabase secrets: `OAUTH_ISSUER`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`. Keep `verify_jwt = false` for the function.
6. **Rotate the old `MCP_ACCESS_KEY`** — it has been exposed and is being retired.
7. (Optional hardening) Add a Custom Access Token Hook to set `aud` = resource URI.

---

## File structure

- **Create** `server/auth.ts` — discovery (AS metadata fetch+cache, `jwks_uri` resolve), `buildProtectedResourceMetadata()`, `createTokenValidator()` (injectable JWKS resolver), `AuthError`, the `WWW-Authenticate` challenge string. No `Deno.serve`; everything exported and testable.
- **Modify** `server/index.ts` — import from `./auth.ts`; add public `.well-known` routes; replace the `x-brain-key` guard with a token-validation middleware; parameterize `buildServer(client)`; build a per-request RLS client; CORS/OPTIONS for new routes; remove static-key path.
- **Modify** `server/deno.json` — add `"jose"`.
- **Create** `server/auth_test.ts` — Deno tests (mock JWKS via locally generated keypair).
- **Create** `schemas/oauth-rls/migration.sql`, `schemas/oauth-rls/metadata.json`, `schemas/oauth-rls/README.md` — tracked PR artifact for the schema change.
- **Mirror (local, gitignored)** the migration into `supabase/migrations/` so the running DB matches.
- **Create** `docs/auth.md` — OAuth model, env/secrets, discovery URLs, `verify_jwt=false`, manual prereqs, verify checklist.
- **Deployment seam:** replace the two file symlinks with one **directory** symlink `supabase/functions/open-brain-mcp -> ../../server` (Task 1) so `auth.ts` deploys alongside `index.ts` and stays single-source.

---

## Task 1: Deployment seam — directory symlink so modules deploy together

**Files:**
- Replace: `supabase/functions/open-brain-mcp/{index.ts,deno.json}` (current file symlinks) with a directory symlink `supabase/functions/open-brain-mcp -> ../../server`.

- [ ] **Step 1: Remove the per-file symlinks and link the directory**

```bash
cd /home/david-a-ventimiglia/Work/OB1/supabase/functions
rm -rf open-brain-mcp
ln -s ../../server open-brain-mcp
ls -l open-brain-mcp            # -> ../../server
ls -l open-brain-mcp/index.ts  # resolves into server/
```

- [ ] **Step 2: Confirm config.toml still resolves**

`supabase/config.toml` already has `entrypoint = "./functions/open-brain-mcp/index.ts"` and `import_map = "./functions/open-brain-mcp/deno.json"`; through the dir symlink these resolve to `server/index.ts` and `server/deno.json`. No edit needed. Verify:

```bash
test -f /home/david-a-ventimiglia/Work/OB1/supabase/functions/open-brain-mcp/deno.json && echo OK
```
Expected: `OK`

- [ ] **Step 3: Deploy smoke test (USER runs — needs their Supabase auth)**

Run: `supabase functions deploy open-brain-mcp --no-verify-jwt`
Expected: deploy succeeds and bundles `server/index.ts` + `server/auth.ts`.
**Fallback if the bundler refuses the symlink:** add `scripts/deploy-mcp.sh` that does `rm -rf supabase/functions/open-brain-mcp && cp -r server supabase/functions/open-brain-mcp && supabase functions deploy open-brain-mcp --no-verify-jwt`. Document whichever is used in `docs/auth.md`.

- [ ] **Step 4: Commit** (the symlink lives under gitignored `supabase/`, so nothing to commit here — note in PR that the local deploy seam is a directory symlink). Skip commit.

---

## Task 2: Add `jose` dependency

**Files:**
- Modify: `server/deno.json`

- [ ] **Step 1: Add jose to the import map**

```json
{
  "imports": {
    "@hono/mcp": "npm:@hono/mcp@0.1.1",
    "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@1.24.3",
    "hono": "npm:hono@4.9.2",
    "zod": "npm:zod@4.1.13",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.47.10",
    "jose": "npm:jose@5.9.6"
  }
}
```
(Pin the exact latest 5.x at implementation time; 5.x has `createRemoteJWKSet`, `jwtVerify`, `createLocalJWKSet`.)

- [ ] **Step 2: Verify it resolves**

Run: `cd server && deno eval 'import { jwtVerify } from "jose"; console.log(typeof jwtVerify)'`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add server/deno.json
git commit -m "[integrations] add jose for OAuth token verification"
```

---

## Task 3: Protected Resource Metadata document (RFC 9728)

**Files:**
- Create: `server/auth.ts`
- Test: `server/auth_test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/auth_test.ts
import { assertEquals } from "jsr:@std/assert";
import { buildProtectedResourceMetadata } from "./auth.ts";

Deno.test("PRM lists the resource and its authorization server", () => {
  const prm = buildProtectedResourceMetadata({
    resource: "https://cznjlmqnxoaykcdzbjry.supabase.co/functions/v1/open-brain-mcp",
    issuer: "https://cznjlmqnxoaykcdzbjry.supabase.co/auth/v1",
  });
  assertEquals(prm.resource, "https://cznjlmqnxoaykcdzbjry.supabase.co/functions/v1/open-brain-mcp");
  assertEquals(prm.authorization_servers, ["https://cznjlmqnxoaykcdzbjry.supabase.co/auth/v1"]);
  assertEquals(prm.bearer_methods_supported, ["header"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && deno test auth_test.ts --allow-net`
Expected: FAIL — `Module not found "./auth.ts"`.

- [ ] **Step 3: Create `server/auth.ts` with the metadata builder**

```ts
// server/auth.ts — OAuth 2.1 resource-server helpers. No Deno.serve; unit-testable.

export interface PrmInput {
  resource: string;
  issuer: string;
}

/** RFC 9728 Protected Resource Metadata document. */
export function buildProtectedResourceMetadata(input: PrmInput) {
  return {
    resource: input.resource,
    authorization_servers: [input.issuer],
    bearer_methods_supported: ["header"],
    // RFC 9728 §3.3 — advertise scopes when scope-based auth is added.
    scopes_supported: [] as string[],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && deno test auth_test.ts --allow-net`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auth.ts server/auth_test.ts
git commit -m "[integrations] add RFC 9728 protected-resource-metadata builder"
```

---

## Task 4: WWW-Authenticate challenge string

**Files:**
- Modify: `server/auth.ts`, `server/auth_test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { wwwAuthenticateChallenge } from "./auth.ts";

Deno.test("WWW-Authenticate points at the resource-metadata URL", () => {
  const h = wwwAuthenticateChallenge(
    "https://cznjlmqnxoaykcdzbjry.supabase.co/functions/v1/open-brain-mcp",
  );
  assertEquals(
    h,
    'Bearer resource_metadata="https://cznjlmqnxoaykcdzbjry.supabase.co/functions/v1/open-brain-mcp/.well-known/oauth-protected-resource"',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && deno test auth_test.ts --allow-net`
Expected: FAIL — `wwwAuthenticateChallenge is not a function`.

- [ ] **Step 3: Implement**

```ts
// in server/auth.ts
export function protectedResourceMetadataUrl(resource: string): string {
  return `${resource}/.well-known/oauth-protected-resource`;
}

export function wwwAuthenticateChallenge(resource: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}"`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && deno test auth_test.ts --allow-net`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auth.ts server/auth_test.ts
git commit -m "[integrations] add RFC 9728 WWW-Authenticate challenge helper"
```

---

## Task 5: AS metadata discovery + jwks_uri resolution (cached)

**Files:**
- Modify: `server/auth.ts`, `server/auth_test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { resolveJwksUri } from "./auth.ts";

Deno.test("resolveJwksUri reads jwks_uri from AS metadata and caches the fetch", async () => {
  let calls = 0;
  const fakeFetch = (_url: string | URL) => {
    calls++;
    return Promise.resolve(
      new Response(JSON.stringify({
        issuer: "https://x.supabase.co/auth/v1",
        jwks_uri: "https://x.supabase.co/auth/v1/.well-known/jwks.json",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  const disc = {
    issuer: "https://x.supabase.co/auth/v1",
    metadataUrl: "https://x.supabase.co/.well-known/oauth-authorization-server/auth/v1",
    fetchImpl: fakeFetch as typeof fetch,
  };
  const uri1 = await resolveJwksUri(disc);
  const uri2 = await resolveJwksUri(disc);
  assertEquals(uri1, "https://x.supabase.co/auth/v1/.well-known/jwks.json");
  assertEquals(uri2, uri1);
  assertEquals(calls, 1); // cached
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && deno test auth_test.ts --allow-net`
Expected: FAIL — `resolveJwksUri is not a function`.

- [ ] **Step 3: Implement discovery with a module-level cache**

```ts
// in server/auth.ts
export interface DiscoveryConfig {
  issuer: string;
  metadataUrl: string;
  fetchImpl?: typeof fetch;
}

const _jwksUriCache = new Map<string, string>();

/** Fetch AS metadata once per metadataUrl and return its jwks_uri. */
export async function resolveJwksUri(cfg: DiscoveryConfig): Promise<string> {
  const cached = _jwksUriCache.get(cfg.metadataUrl);
  if (cached) return cached;
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(cfg.metadataUrl);
  if (!res.ok) throw new Error(`AS metadata fetch failed: ${res.status}`);
  const meta = await res.json() as { issuer?: string; jwks_uri?: string };
  if (meta.issuer && meta.issuer !== cfg.issuer) {
    throw new Error(`AS issuer mismatch: ${meta.issuer} != ${cfg.issuer}`);
  }
  if (!meta.jwks_uri) throw new Error("AS metadata missing jwks_uri");
  _jwksUriCache.set(cfg.metadataUrl, meta.jwks_uri);
  return meta.jwks_uri;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && deno test auth_test.ts --allow-net`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auth.ts server/auth_test.ts
git commit -m "[integrations] resolve jwks_uri from AS metadata with caching"
```

---

## Task 6: Token validator (signature, iss, exp, client_id) with injectable JWKS

**Files:**
- Modify: `server/auth.ts`, `server/auth_test.ts`

Design: `createTokenValidator()` returns `validate(authorizationHeader): Promise<Claims>`. JWKS lookup is injected so tests use a locally generated keypair; production uses `createRemoteJWKSet(new URL(jwks_uri))` (jose handles TTL + refresh-on-unknown-kid). Throws `AuthError` (→ 401) on any failure.

- [ ] **Step 1: Write the failing tests (valid / expired / bad-signature / wrong-issuer / wrong-client / missing)**

```ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createTokenValidator, AuthError } from "./auth.ts";

const ISSUER = "https://x.supabase.co/auth/v1";
const CLIENT_ID = "11111111-1111-1111-1111-111111111111";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid"; jwk.alg = "RS256"; jwk.use = "sig";
  const keySet = { keys: [jwk] };
  // Inject a local JWKS resolver (jose createLocalJWKSet equivalent).
  const validate = createTokenValidator({
    issuer: ISSUER,
    expectedClientId: CLIENT_ID,
    getKeySet: () => Promise.resolve(keySet),
  });
  const sign = (claims: Record<string, unknown>, exp = "5m", kid = "test-kid") =>
    new SignJWT({ role: "authenticated", client_id: CLIENT_ID, ...claims })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(ISSUER).setIssuedAt().setExpirationTime(exp)
      .sign(privateKey);
  return { validate, sign, privateKey };
}

Deno.test("valid token returns claims", async () => {
  const { validate, sign } = await setup();
  const claims = await validate(`Bearer ${await sign({ sub: "user-1" })}`);
  assertEquals(claims.client_id, CLIENT_ID);
  assertEquals(claims.iss, ISSUER);
});

Deno.test("missing/garbage header is rejected", async () => {
  const { validate } = await setup();
  await assertRejects(() => validate(undefined), AuthError);
  await assertRejects(() => validate("Basic abc"), AuthError);
});

Deno.test("expired token is rejected", async () => {
  const { validate, sign } = await setup();
  await assertRejects(() => validate(`Bearer ${await sign({}, "-1m")}`), AuthError);
});

Deno.test("wrong issuer is rejected", async () => {
  const { sign } = await setup();
  const bad = createTokenValidator({
    issuer: "https://evil.example/auth/v1",
    expectedClientId: CLIENT_ID,
    getKeySet: () => setup().then((s) => s.validate) as never, // placeholder, see note
  });
  // Simpler: sign with ISSUER but validate expecting a different issuer.
  const { validate: _ } = await setup();
  await assertRejects(
    () => createTokenValidator({
      issuer: "https://other/auth/v1",
      expectedClientId: CLIENT_ID,
      getKeySet: bad ? undefined as never : undefined as never,
    }) as never,
    Error,
  );
});

Deno.test("wrong client_id is rejected", async () => {
  const { validate, sign } = await setup();
  await assertRejects(
    () => validate(`Bearer ${await sign({ client_id: "99999999-9999-9999-9999-999999999999" })}`),
    AuthError,
  );
});

Deno.test("bad signature is rejected", async () => {
  const { validate } = await setup();
  const { privateKey: otherKey } = await generateKeyPair("RS256");
  const forged = await new SignJWT({ role: "authenticated", client_id: CLIENT_ID })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(ISSUER).setIssuedAt().setExpirationTime("5m").sign(otherKey);
  await assertRejects(() => validate(`Bearer ${forged}`), AuthError);
});
```

> Note for the implementer: simplify the "wrong issuer" test to: build a validator with `issuer: "https://other/auth/v1"` but the same `getKeySet`, sign a token with `ISSUER`, and assert it rejects. Keep the keypair/JWKS from `setup()`. The snippet above is intentionally pseudo for that one case — write it the simple way.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && deno test auth_test.ts --allow-net`
Expected: FAIL — `createTokenValidator is not a function`.

- [ ] **Step 3: Implement the validator**

```ts
// in server/auth.ts
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export class AuthError extends Error {
  constructor(message: string) { super(message); this.name = "AuthError"; }
}

export interface Claims extends JWTPayload {
  client_id?: string;
  role?: string;
}

export interface ValidatorConfig {
  issuer: string;
  expectedClientId: string;
  /** Test seam: return a JWKS object. If omitted, a remote JWKS at jwksUri is used. */
  getKeySet?: () => Promise<{ keys: unknown[] }>;
  jwksUri?: string;
}

export function createTokenValidator(cfg: ValidatorConfig) {
  // jose's createRemoteJWKSet caches keys and refetches on unknown kid (cooldown-limited).
  const remote = cfg.jwksUri ? createRemoteJWKSet(new URL(cfg.jwksUri)) : null;

  return async function validate(authorization: string | undefined): Promise<Claims> {
    if (!authorization || !authorization.startsWith("Bearer ")) {
      throw new AuthError("missing bearer token");
    }
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) throw new AuthError("empty bearer token");

    const keyLookup = cfg.getKeySet
      ? createLocalJWKSet(await cfg.getKeySet() as never)
      : remote;
    if (!keyLookup) throw new AuthError("no JWKS configured");

    let payload: Claims;
    try {
      const result = await jwtVerify(token, keyLookup as never, { issuer: cfg.issuer });
      payload = result.payload as Claims;
    } catch (e) {
      throw new AuthError(`token verification failed: ${(e as Error).message}`);
    }
    // Audience substitute: Supabase aud is generic ("authenticated"), so bind on client_id.
    if (payload.client_id !== cfg.expectedClientId) {
      throw new AuthError("token client_id does not match registered client");
    }
    return payload;
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && deno test auth_test.ts --allow-net`
Expected: PASS (all token cases).

- [ ] **Step 5: Commit**

```bash
git add server/auth.ts server/auth_test.ts
git commit -m "[integrations] add JWKS-backed OAuth token validator (iss/exp/client_id)"
```

---

## Task 7: Schema migration — client_id column + RLS policies

**Files:**
- Create: `schemas/oauth-rls/migration.sql`, `schemas/oauth-rls/metadata.json`, `schemas/oauth-rls/README.md`
- Mirror (local, gitignored): copy `migration.sql` into `supabase/migrations/<timestamp>_oauth_rls.sql`

Guard rail: this **adds** a column to `thoughts` (allowed) and **adds** policies; it does not alter/drop existing columns. Keeps the existing `service_role` policy for the embedding/admin path.

- [ ] **Step 1: Write `schemas/oauth-rls/migration.sql`**

```sql
-- OAuth RLS scoping for the thoughts table.
-- Adds per-client ownership and policies keyed on the JWT client_id claim.

-- 1. Per-client ownership column (nullable; legacy rows have NULL).
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS client_id text;
CREATE INDEX IF NOT EXISTS idx_thoughts_client_id ON thoughts (client_id);

-- 2. Authenticated OAuth clients may only see/modify their own rows.
CREATE POLICY "oauth client reads own thoughts"
  ON thoughts FOR SELECT TO authenticated
  USING (client_id = (auth.jwt() ->> 'client_id'));

CREATE POLICY "oauth client inserts own thoughts"
  ON thoughts FOR INSERT TO authenticated
  WITH CHECK (client_id = (auth.jwt() ->> 'client_id'));

CREATE POLICY "oauth client updates own thoughts"
  ON thoughts FOR UPDATE TO authenticated
  USING (client_id = (auth.jwt() ->> 'client_id'))
  WITH CHECK (client_id = (auth.jwt() ->> 'client_id'));

CREATE POLICY "oauth client deletes own thoughts"
  ON thoughts FOR DELETE TO authenticated
  USING (client_id = (auth.jwt() ->> 'client_id'));

-- 3. upsert_thought must stamp client_id from the caller's JWT and run as INVOKER
--    so RLS applies. (Original definition created it without client_id.)
CREATE OR REPLACE FUNCTION upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_fingerprint TEXT;
  v_client_id TEXT := (auth.jwt() ->> 'client_id');
  v_id UUID;
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8')), 'hex');
  INSERT INTO thoughts (content, content_fingerprint, metadata, client_id)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb), v_client_id)
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(),
        metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$;

-- 4. match_thoughts runs as INVOKER so the SELECT is RLS-filtered to the caller.
--    (Re-declare with SECURITY INVOKER; body unchanged from the base migration.)
--    See schemas/oauth-rls/README.md for the full body to paste.
```

> Implementer: paste the existing `match_thoughts` body from `supabase/migrations/20260615214150_*.sql` and add `SECURITY INVOKER`. Confirm it is not relied on elsewhere as `SECURITY DEFINER`.

- [ ] **Step 2: Write `schemas/oauth-rls/metadata.json`** (per `.github/metadata.schema.json` — validate field names against that schema at impl time)

```json
{
  "name": "oauth-rls",
  "category": "schemas",
  "description": "Per-client RLS scoping for the thoughts table, keyed on the OAuth client_id JWT claim.",
  "version": "1.0.0",
  "author": "david-a-ventimiglia",
  "license": "FSL-1.1-MIT"
}
```

- [ ] **Step 3: Write `schemas/oauth-rls/README.md`** — what it adds, why (OAuth resource-server scoping), how to apply (`supabase db push` or paste in SQL editor), and the legacy-NULL-rows note (pre-OAuth rows have `client_id IS NULL` and are invisible to OAuth clients until backfilled).

- [ ] **Step 4: Mirror into the local (gitignored) migrations dir so the running DB matches**

```bash
cp /home/david-a-ventimiglia/Work/OB1/schemas/oauth-rls/migration.sql \
   "/home/david-a-ventimiglia/Work/OB1/supabase/migrations/20260615220000_oauth_rls.sql"
```
(USER applies via `supabase db push` against their project — not automated here.)

- [ ] **Step 5: Commit (tracked artifact only)**

```bash
git add schemas/oauth-rls/
git commit -m "[schemas] add per-client OAuth RLS scoping for thoughts"
```

---

## Task 8: Per-request RLS client + parameterize buildServer

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Add a factory for the per-request, JWT-scoped Supabase client**

```ts
// server/index.ts — near the top, after SUPABASE_URL is defined.
// Keep the module-level service-role client ONLY for non-user/admin paths.
function userClient(accessToken: string) {
  return createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

> Requires a new secret `SUPABASE_ANON_KEY`. The anon key + caller JWT makes PostgREST run as `authenticated` with the JWT claims visible to `auth.jwt()`. Do **not** use the service-role key for user reads/writes (it bypasses RLS).

- [ ] **Step 2: Change `buildServer()` to accept the request-scoped client**

Modify `function buildServer(): McpServer {` → `function buildServer(db: SupabaseClient): McpServer {` and replace every `supabase.` inside it (lines ~125, 172, 229, 308, 377, 381, 462, 475) with `db.`. Import the type: `import { createClient, type SupabaseClient } from "@supabase/supabase-js";`

- [ ] **Step 3: Type-check**

Run: `cd server && deno check index.ts`
Expected: no errors (build will fail until Task 9 supplies `db` at the call site — that's fine; do Task 9 next).

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "[integrations] parameterize buildServer with a per-request RLS client"
```

---

## Task 9: Wire discovery routes + token middleware; remove x-brain-key

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Add config + validator construction near module top**

```ts
const RESOURCE = "https://cznjlmqnxoaykcdzbjry.supabase.co/functions/v1/open-brain-mcp";
const OAUTH_ISSUER = Deno.env.get("OAUTH_ISSUER")!; // https://<ref>.supabase.co/auth/v1
const OAUTH_CLIENT_ID = Deno.env.get("OAUTH_CLIENT_ID")!;
const AS_METADATA_URL =
  `https://cznjlmqnxoaykcdzbjry.supabase.co/.well-known/oauth-authorization-server/auth/v1`;

let _validate: ((auth: string | undefined) => Promise<Claims>) | null = null;
async function getValidator() {
  if (_validate) return _validate;
  const jwksUri = await resolveJwksUri({ issuer: OAUTH_ISSUER, metadataUrl: AS_METADATA_URL });
  _validate = createTokenValidator({ issuer: OAUTH_ISSUER, expectedClientId: OAUTH_CLIENT_ID, jwksUri });
  return _validate;
}
```

Add imports: `import { buildProtectedResourceMetadata, wwwAuthenticateChallenge, resolveJwksUri, createTokenValidator, AuthError, type Claims } from "./auth.ts";`

- [ ] **Step 2: Add public discovery route BEFORE the catch-all**

```ts
app.get("/functions/v1/open-brain-mcp/.well-known/oauth-protected-resource", (c) =>
  c.json(buildProtectedResourceMetadata({ resource: RESOURCE, issuer: OAUTH_ISSUER }), 200, corsHeaders));
// Also serve at the bare path in case the platform strips the function prefix:
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json(buildProtectedResourceMetadata({ resource: RESOURCE, issuer: OAUTH_ISSUER }), 200, corsHeaders));
```

- [ ] **Step 3: Replace the `x-brain-key` guard in the catch-all with token validation**

Replace lines ~604–615 (the `const provided = ... unauthorizedResponse(id)` block) with:

```ts
const authz = c.req.header("authorization");
let claims: Claims;
try {
  const validate = await getValidator();
  claims = await validate(authz);
} catch (e) {
  if (e instanceof AuthError || true) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        ...corsHeaders,
        "content-type": "application/json",
        "WWW-Authenticate": wwwAuthenticateChallenge(RESOURCE),
      },
    });
  }
}
const accessToken = authz!.slice("Bearer ".length).trim();
const db = userClient(accessToken);
```

Then change `const server = buildServer();` → `const server = buildServer(db);`.

> This replaces the old JSON-RPC-200 "soft" unauthorized with a real **HTTP 401 + WWW-Authenticate** — required so claude.ai's connector starts the OAuth flow. Remove the now-unused `MCP_ACCESS_KEY`, `unauthorizedResponse`, and `extractJsonRpcId`/`readBodyText` if they were only used for the key path (verify with grep before deleting).

- [ ] **Step 4: Ensure CORS exposes WWW-Authenticate**

In `corsHeaders`, add `"Access-Control-Expose-Headers": "WWW-Authenticate"` and confirm `Access-Control-Allow-Headers` still includes `authorization` (it does). Remove `x-brain-key` from `Access-Control-Allow-Headers` (line 515).

- [ ] **Step 5: Type-check + run all tests**

Run: `cd server && deno check index.ts && deno test --allow-net`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add server/index.ts
git commit -m "[integrations] serve OAuth discovery, validate tokens, return 401 challenge"
```

---

## Task 10: Scrub the static key from the whole repo

**Files:**
- Modify: any file referencing `x-brain-key` / `MCP_ACCESS_KEY` / a hardcoded key (code, docs, CI, tests).

- [ ] **Step 1: Find every reference**

```bash
cd /home/david-a-ventimiglia/Work/OB1
grep -rniE "x-brain-key|MCP_ACCESS_KEY|\?key=" --include="*.ts" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.json" --include="*.mjs" . | grep -v node_modules
```

- [ ] **Step 2: Remove/replace each hit**

Replace key-based connection instructions with the OAuth connector flow; delete dead code paths; update `server/test-stateless.mjs` if it sends `x-brain-key`. Leave the getting-started doc changes to Task 11.

- [ ] **Step 3: Verify clean**

Run the grep again. Expected: no functional references remain (only historical/changelog mentions, clearly marked).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "[integrations] retire static x-brain-key auth path"
```

---

## Task 11: Docs

**Files:**
- Create: `docs/auth.md`
- Modify: README and `docs/01-getting-started.md` connection sections (note the breaking change; point Step 7 at the OAuth connector flow).

- [ ] **Step 1: Write `docs/auth.md`** covering: the OAuth resource-server model; `verify_jwt = false` requirement + why; env/secrets (`OAUTH_ISSUER`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `SUPABASE_ANON_KEY`); discovery URLs (PRM + AS metadata + jwks); the `client_id`/`aud` caveat + residual confused-deputy risk + optional access-token hook; the full manual-prereq list; and the deploy seam (directory symlink / copy fallback).

- [ ] **Step 2: Add a "how to verify" checklist** (mirrors PR): curl both discovery URLs and confirm valid JSON; curl the MCP endpoint with no token and confirm `401` + `WWW-Authenticate`; complete the connect flow in claude.ai.

- [ ] **Step 3: Commit**

```bash
git add docs/auth.md README.md docs/01-getting-started.md
git commit -m "[docs] document OAuth resource-server model and manual prerequisites"
```

---

## Task 12: Branch + PR

- [ ] **Step 1: Confirm branch** (created at execution start): `git rev-parse --abbrev-ref HEAD` → `feat/oauth-resource-server`.
- [ ] **Step 2: Push** `git push -u origin feat/oauth-resource-server`.
- [ ] **Step 3: Open PR** titled `[integrations] OAuth 2.1 resource-server auth for open-brain MCP` with a body containing:
  - Summary of code changes.
  - **BREAKING CHANGE** banner: replaces static-key auth in the canonical server; all users must migrate to the OAuth connector flow — needs maintainer sign-off.
  - The **manual prerequisites** list (Tasks' prereq section verbatim): enable OAuth server + DCR off; build/host consent page; register client + capture creds; register Claude's exact redirect URI; set env secrets; **rotate the exposed old MCP_ACCESS_KEY**.
  - The residual `aud`/confused-deputy note + optional access-token hook.
  - The "how to verify" checklist.

---

## Self-review notes

- **Spec coverage:** discovery (T3,T4,T9) · token validation valid/expired/bad-sig/wrong-iss/wrong-client/missing (T6) · JWKS cache+refresh (T5 + jose remote set) · RLS per-request client, no service-role for user ops (T8,T9) · client_id RLS policies + schema (T7) · `verify_jwt=false` (already set; documented T11) · retire static key + scrub + rotate reminder (T10,T12) · CORS/OPTIONS (T9) · no secrets in logs (review during T9) · tests (T3–T6) · docs (T11) · PR (T12).
- **Known gaps to confirm during execution:** (a) does `SUPABASE_ANON_KEY` + caller JWT yield `authenticated` role with `client_id` visible to `auth.jwt()` on this project — verify with a live token before trusting RLS; (b) does Supabase deploy follow the directory symlink (T1 step 3) — else use copy fallback; (c) `match_thoughts`/`upsert_thought` must be `SECURITY INVOKER` or RLS is bypassed (T7); (d) the test layer can't exercise the no-token-never-reaches-tools path end-to-end without booting the server — covered indirectly by the middleware unit tests; add an integration smoke test against the deployed function in the verify checklist.
