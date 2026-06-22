/** Minimal server-rendered HTML for the shared login + claim flows. */

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0;
    display: grid; place-items: center; min-height: 100vh; background: #0b0d12; color: #e7e9ee; }
  .card { width: 340px; padding: 28px; border: 1px solid #232838; border-radius: 14px; background: #11141c; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #8b93a7; font-size: 13px; }
  label { display: block; font-size: 12px; color: #8b93a7; margin: 12px 0 4px; }
  input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a3043;
    background: #0b0d12; color: #e7e9ee; font-size: 14px; }
  button { width: 100%; margin-top: 18px; padding: 11px; border: 0; border-radius: 8px;
    background: #5b7cff; color: #fff; font-weight: 600; font-size: 14px; cursor: pointer; }
  .err { color: #ff7a85; font-size: 13px; margin-top: 12px; }
  .brand { font-weight: 700; letter-spacing: .04em; color: #5b7cff; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title><style>${STYLE}</style></head>
    <body><div class="card">${body}</div></body></html>`;
}

export function loginPage(next: string, error?: string): string {
  return page(
    "Sign in · Vibe Base",
    `<h1><span class="brand">Vibe</span> Base</h1>
     <p class="sub">Private — sign in to continue.</p>
     <form method="post" action="/login">
       <input type="hidden" name="next" value="${escapeAttr(next)}">
       <label>Email</label>
       <input name="email" type="email" autocomplete="username" required autofocus>
       <label>Password</label>
       <input name="password" type="password" autocomplete="current-password" required>
       <button type="submit">Sign in</button>
       ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
     </form>`
  );
}

export function claimPage(tokenValue: string, email: string, error?: string): string {
  return page(
    "Accept invite · Vibe Base",
    `<h1>Accept your invite</h1>
     <p class="sub">Set a password for <b>${escapeHtml(email)}</b>.</p>
     <form method="post" action="/claim">
       <input type="hidden" name="token" value="${escapeAttr(tokenValue)}">
       <label>Choose a password</label>
       <input name="password" type="password" autocomplete="new-password" required autofocus minlength="8">
       <button type="submit">Set password & continue</button>
       ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
     </form>`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
