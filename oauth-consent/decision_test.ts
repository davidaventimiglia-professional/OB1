import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  chooseEntryAction,
  csrfTokensMatch,
  generateCsrfToken,
  parseDecision,
} from "./decision.ts";

Deno.test("generateCsrfToken returns a long unguessable string", () => {
  const a = generateCsrfToken();
  const b = generateCsrfToken();
  assert(a.length >= 32);
  assert(a !== b);
});

Deno.test("csrfTokensMatch only matches identical non-empty tokens", () => {
  const t = generateCsrfToken();
  assert(csrfTokensMatch(t, t));
  assert(!csrfTokensMatch(t, t + "x"));
  assert(!csrfTokensMatch(undefined, t));
  assert(!csrfTokensMatch(t, undefined));
  assert(!csrfTokensMatch("", ""));
});

Deno.test("parseDecision accepts only approve/deny", () => {
  assertEquals(parseDecision("approve"), "approve");
  assertEquals(parseDecision("deny"), "deny");
  assertEquals(parseDecision("APPROVE"), null);
  assertEquals(parseDecision(undefined), null);
  assertEquals(parseDecision("maybe"), null);
});

Deno.test("chooseEntryAction picks the first action by precedence", () => {
  assertEquals(chooseEntryAction({ hasCode: true, authenticated: false }), "exchange-code");
  assertEquals(chooseEntryAction({ hasCode: true, authenticated: true }), "exchange-code");
  assertEquals(chooseEntryAction({ hasCode: false, authenticated: true }), "show-consent");
  assertEquals(chooseEntryAction({ hasCode: false, authenticated: false }), "begin-signin");
});
