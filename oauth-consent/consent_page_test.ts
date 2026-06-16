import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { consentPage, errorPage, escapeHtml, signInPage } from "./consent_page.ts";

Deno.test("escapeHtml neutralizes HTML metacharacters", () => {
  assertEquals(escapeHtml(`<script>"&'`), "&lt;script&gt;&quot;&amp;&#39;");
});

Deno.test("signInPage links to the provider URL and escapes the client name", () => {
  const html = signInPage("https://gh/auth?x=1&y=2", "<b>Evil</b>");
  assertStringIncludes(html, "https://gh/auth?x=1&amp;y=2");
  assertStringIncludes(html, "&lt;b&gt;Evil&lt;/b&gt;");
  assert(!html.includes("<b>Evil</b>"));
});

Deno.test("consentPage embeds authorization_id, csrf token, scopes, and both buttons", () => {
  const html = consentPage({
    clientName: "Claude",
    scopes: ["openid", "profile"],
    authorizationId: "auth-123",
    csrfToken: "tok-abc",
  });
  assertStringIncludes(html, 'name="authorization_id" value="auth-123"');
  assertStringIncludes(html, 'name="csrf" value="tok-abc"');
  assertStringIncludes(html, "openid");
  assertStringIncludes(html, "profile");
  assertStringIncludes(html, 'value="approve"');
  assertStringIncludes(html, 'value="deny"');
  assertStringIncludes(html, 'action="/functions/v1/oauth-consent/decision"');
});

Deno.test("errorPage shows the message and optional retry link", () => {
  assertStringIncludes(errorPage("boom"), "boom");
  assertStringIncludes(errorPage("boom", { retryUrl: "/retry" }), 'href="/retry"');
});
