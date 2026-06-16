const DECISION_ACTION = "/functions/v1/oauth-consent/decision";

export function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
  .btn { display: inline-block; padding: .6rem 1rem; border-radius: .5rem; background: #111; color: #fff; text-decoration: none; border: 0; cursor: pointer; font-size: 1rem; }
  .btn.secondary { background: #fff; color: #111; border: 1px solid #ccc; }
  form { display: flex; gap: .75rem; margin-top: 1.5rem; }
  ul { background: #f5f5f5; border-radius: .5rem; padding: 1rem 1rem 1rem 2rem; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function signInPage(providerUrl: string, clientName: string): string {
  return layout("Authorize", `
<h1>Authorize ${escapeHtml(clientName)}</h1>
<p>Sign in with GitHub to review and approve this request.</p>
<a class="btn" href="${escapeHtml(providerUrl)}">Continue with GitHub</a>
`);
}

export function consentPage(opts: {
  clientName: string;
  scopes: string[];
  authorizationId: string;
  csrfToken: string;
}): string {
  const scopeItems = opts.scopes.length
    ? opts.scopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("")
    : "<li>(no scopes requested)</li>";
  return layout("Authorize", `
<h1>${escapeHtml(opts.clientName)} wants access</h1>
<p>It is requesting these permissions on your Open Brain:</p>
<ul>${scopeItems}</ul>
<form method="POST" action="${DECISION_ACTION}">
  <input type="hidden" name="authorization_id" value="${escapeHtml(opts.authorizationId)}">
  <input type="hidden" name="csrf" value="${escapeHtml(opts.csrfToken)}">
  <button class="btn" type="submit" name="decision" value="approve">Approve</button>
  <button class="btn secondary" type="submit" name="decision" value="deny">Deny</button>
</form>
`);
}

export function errorPage(message: string, opts?: { retryUrl?: string }): string {
  const retry = opts?.retryUrl ? `<p><a href="${escapeHtml(opts.retryUrl)}">Try again</a></p>` : "";
  return layout("Error", `
<h1>Something went wrong</h1>
<p>${escapeHtml(message)}</p>
${retry}
`);
}
