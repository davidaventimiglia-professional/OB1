// Regression test for the RFC 9728 discovery routing. The Supabase Edge runtime
// delivers the request path as `/<function-slug>/…` (not the full
// `/functions/v1/<slug>/…` nor a stripped `/…`), which once made hardcoded
// discovery routes 404 into the auth catch-all. The handler now matches by path
// suffix; this test pins that behavior across all three path shapes.

import { assertEquals } from "jsr:@std/assert@1";

// OAUTH_* are read at module load, so set them before importing index.ts.
Deno.env.set("OAUTH_ISSUER", "https://example.supabase.co/auth/v1");
Deno.env.set("OAUTH_RESOURCE", "https://example.supabase.co/functions/v1/open-brain-mcp");
Deno.env.set("OAUTH_CLIENT_ID", "test-client-id");
Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");

const { app } = await import("./index.ts");

const DISCOVERY = "/.well-known/oauth-protected-resource";

Deno.test("serves protected-resource metadata regardless of path prefix", async () => {
  // The slug-prefixed form is what the Edge runtime actually delivers; the
  // full and bare forms are covered too since matching is by suffix.
  for (const path of [
    `/open-brain-mcp${DISCOVERY}`,
    `/functions/v1/open-brain-mcp${DISCOVERY}`,
    DISCOVERY,
  ]) {
    const res = await app.fetch(new Request(`https://x${path}`));
    assertEquals(res.status, 200, `status for ${path}`);
    const body = await res.json();
    assertEquals(body.resource, "https://example.supabase.co/functions/v1/open-brain-mcp", path);
    assertEquals(body.authorization_servers, ["https://example.supabase.co/auth/v1"], path);
  }
});

Deno.test("discovery is public — no Authorization header required", async () => {
  const res = await app.fetch(new Request(`https://x/open-brain-mcp${DISCOVERY}`));
  assertEquals(res.status, 200);
});
