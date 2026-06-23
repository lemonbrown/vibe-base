/** Minimal server-rendered HTML for the shared login + claim flows. */

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; display: grid; place-items: center; min-height: 100svh;
    background:
      radial-gradient(1200px 600px at 50% -10%, rgba(91,124,255,.10), transparent 60%),
      #0b0d12;
    color: #e7e9ee; -webkit-font-smoothing: antialiased;
    padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom); }
  .card { width: 100%; max-width: 360px; padding: 28px; border: 1px solid #1f2533;
    border-radius: 16px; background: #11141c; box-shadow: 0 20px 60px -30px rgba(0,0,0,.8); }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  p.sub { margin: 0 0 22px; color: #8b93a7; font-size: 13px; }
  label { display: block; font-size: 12px; color: #8b93a7; margin: 14px 0 6px; }
  input { width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid #2a3043;
    background: #0b0d12; color: #e7e9ee; font-size: 14px; outline: none; transition: border-color .15s, box-shadow .15s; }
  input:focus { border-color: #5b7cff; box-shadow: 0 0 0 3px rgba(91,124,255,.18); }
  button { width: 100%; margin-top: 20px; padding: 12px; border: 0; border-radius: 10px;
    background: #5b7cff; color: #fff; font-weight: 600; font-size: 14px; cursor: pointer;
    transition: background .15s; }
  button:hover { background: #4a6bff; }
  .err { color: #ff7a85; font-size: 13px; margin-top: 14px; }
  .brand { font-weight: 700; letter-spacing: .04em; color: #5b7cff; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="theme-color" content="#0b0d12">
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
