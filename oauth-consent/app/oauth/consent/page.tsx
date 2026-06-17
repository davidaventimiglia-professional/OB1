import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isConsentDetails, parseScopes } from "@/lib/oauth";
import { ConsentForm } from "./consent-form";

const ERROR_MESSAGES: Record<string, string> = {
  signin_failed: "Sign-in failed. Please try again.",
  decision_failed: "We could not record your decision. Please try again.",
};

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string; error?: string }>;
}) {
  const { authorization_id: authorizationId, error } = await searchParams;

  if (error) {
    return <p>{ERROR_MESSAGES[error] ?? "Something went wrong."}</p>;
  }
  if (!authorizationId) {
    return <p>This consent link is missing its authorization id.</p>;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(
      `/auth/signin?authorization_id=${encodeURIComponent(authorizationId)}`,
    );
  }

  const { data, error: detailsError } =
    await supabase.auth.oauth.getAuthorizationDetails(authorizationId);

  if (detailsError || !data) {
    return <p>This authorization request has expired or is invalid.</p>;
  }
  if (!isConsentDetails(data)) {
    redirect(data.redirect_url);
  }

  return (
    <ConsentForm
      authorizationId={authorizationId}
      clientName={data.client?.name ?? "this application"}
      scopes={parseScopes(data.scope)}
    />
  );
}
