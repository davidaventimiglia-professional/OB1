import { describe, expect, it } from "vitest";
import { isConsentDetails, parseDecision, parseScopes } from "./oauth";

describe("parseScopes", () => {
  it("splits on whitespace and drops empties", () => {
    expect(parseScopes("openid profile email")).toEqual(["openid", "profile", "email"]);
    expect(parseScopes("  a   b ")).toEqual(["a", "b"]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe("parseDecision", () => {
  it("accepts only approve/deny", () => {
    expect(parseDecision("approve")).toBe("approve");
    expect(parseDecision("deny")).toBe("deny");
    expect(parseDecision("APPROVE")).toBeNull();
    expect(parseDecision("maybe")).toBeNull();
    expect(parseDecision(undefined)).toBeNull();
    expect(parseDecision(null)).toBeNull();
  });
});

describe("isConsentDetails", () => {
  it("detects the consent-details shape vs the already-consented redirect shape", () => {
    expect(isConsentDetails({ authorization_id: "x", client: { name: "C" }, scope: "openid" })).toBe(true);
    expect(isConsentDetails({ redirect_url: "https://app/callback?code=1" })).toBe(false);
  });
});
