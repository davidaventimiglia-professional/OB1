import { assertEquals } from "jsr:@std/assert@1";
import { createServerClient } from "@supabase/ssr";

Deno.test("pinned client exposes auth.oauth.* consent methods", () => {
  const client = createServerClient(
    "https://example.supabase.co",
    "anon-key",
    { cookies: { getAll: () => [], setAll: () => {} } },
  );
  assertEquals(typeof client.auth.oauth.getAuthorizationDetails, "function");
  assertEquals(typeof client.auth.oauth.approveAuthorization, "function");
  assertEquals(typeof client.auth.oauth.denyAuthorization, "function");
});
