import { assertEquals } from "jsr:@std/assert@1";
import { app } from "./index.ts";

Deno.test("GET entry without authorization_id returns 400", async () => {
  const res = await app.fetch(new Request("https://x/functions/v1/oauth-consent"));
  assertEquals(res.status, 400);
});

Deno.test("POST decision with missing fields returns 400 before any Supabase call", async () => {
  const res = await app.fetch(
    new Request("https://x/functions/v1/oauth-consent/decision", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approve", // no authorization_id
    }),
  );
  assertEquals(res.status, 400);
});
