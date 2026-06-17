"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Decision } from "@/lib/oauth";

// Records the user's approve/deny decision. The decision is bound as an argument
// because a submit button's name/value is NOT reliably delivered to a Server
// Action invoked via formAction. CSRF is enforced by Next's built-in Server
// Action Origin check. redirect() throws, so control never falls through.
export async function decideAction(decision: Decision, formData: FormData) {
  const authorizationId = String(formData.get("authorization_id") ?? "");

  if (!authorizationId) {
    redirect("/oauth/consent?error=decision_failed");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(
      `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`,
    );
  }

  const result =
    decision === "approve"
      ? await supabase.auth.oauth.approveAuthorization(authorizationId, {
          skipBrowserRedirect: true,
        })
      : await supabase.auth.oauth.denyAuthorization(authorizationId, {
          skipBrowserRedirect: true,
        });

  if (result.error || !result.data?.redirect_url) {
    redirect(
      `/oauth/consent?error=decision_failed&authorization_id=${encodeURIComponent(authorizationId)}`,
    );
  }

  redirect(result.data.redirect_url);
}
