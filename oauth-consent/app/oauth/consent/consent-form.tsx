import { decideAction } from "@/app/actions";

// React escapes interpolated text by default, so clientName/scope are XSS-safe.
export function ConsentForm({
  authorizationId,
  clientName,
  scopes,
}: {
  authorizationId: string;
  clientName: string;
  scopes: string[];
}) {
  return (
    <>
      <h1>{clientName} wants access</h1>
      <p>It is requesting these permissions on your Open Brain:</p>
      <ul>
        {scopes.length > 0 ? (
          scopes.map((s) => <li key={s}>{s}</li>)
        ) : (
          <li>(no scopes requested)</li>
        )}
      </ul>
      <form style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem" }}>
        <input type="hidden" name="authorization_id" value={authorizationId} />
        <button type="submit" formAction={decideAction} name="decision" value="approve">
          Approve
        </button>
        <button type="submit" formAction={decideAction} name="decision" value="deny">
          Deny
        </button>
      </form>
    </>
  );
}
