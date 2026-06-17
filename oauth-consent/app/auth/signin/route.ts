import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Kicks off GitHub OAuth. Supabase writes the PKCE verifier cookie; we issue
// the redirect ourselves (skipBrowserRedirect: true, no browser window here).
export async function GET(request: NextRequest) {
  const authorizationId = request.nextUrl.searchParams.get("authorization_id");

  const supabase = await createClient();
  const callback = new URL("/auth/callback", request.url);
  if (authorizationId) {
    callback.searchParams.set("authorization_id", authorizationId);
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: callback.toString(), skipBrowserRedirect: true },
  });

  if (error || !data?.url) {
    return NextResponse.redirect(
      new URL("/oauth/consent?error=signin_failed", request.url),
    );
  }
  return NextResponse.redirect(data.url);
}
