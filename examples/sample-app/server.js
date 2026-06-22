import http from "node:http";

// The platform always injects $PORT. Listen on it, never a hardcoded port.
const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Health endpoint the platform polls before flipping traffic to this version.
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Gateway auth: the signed-in user arrives as trusted request headers.
  // This app never implements login.
  const email = req.headers["x-vibe-user-email"] || "(anonymous)";
  const role = req.headers["x-vibe-user-role"] || "(none)";

  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><meta charset="utf-8">
    <title>${process.env.VIBE_APP_NAME || "Vibe Sample"}</title>
    <body style="font:16px system-ui;max-width:640px;margin:60px auto;padding:0 20px">
    <h1>🎉 ${process.env.VIBE_APP_NAME || "Vibe Sample App"}</h1>
    <p>Deployed by Vibe Base and running behind gateway auth.</p>
    <ul>
      <li>Signed in as: <b>${email}</b></li>
      <li>Role: <b>${role}</b></li>
      <li>App id: <b>${process.env.VIBE_APP_ID || "?"}</b></li>
      <li>Database configured: <b>${process.env.DATABASE_URL ? "yes" : "no"}</b></li>
    </ul>
    </body>`);
});

server.listen(port, () => console.log(`sample app listening on :${port}`));
