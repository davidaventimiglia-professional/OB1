import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Per-request server client. Must be created per request (never shared).
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll throws when called from a Server Component (cookies are
            // read-only there). Safe to ignore: middleware refreshes the session.
          }
        },
      },
    },
  );
}
