import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GitHub -> Supabase returns here with ?code (and our preserved authorization_id).
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const authorizationId = request.nextUrl.searchParams.get("authorization_id");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        new URL("/oauth/consent?error=signin_failed", request.url),
      );
    }
  }

  const dest = new URL("/oauth/consent", request.url);
  if (authorizationId) {
    dest.searchParams.set("authorization_id", authorizationId);
  }
  return NextResponse.redirect(dest);
}
