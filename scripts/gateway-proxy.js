/**
 * Reproduction harness — NOT part of the app.
 *
 * Mimics the reverse gateway in front of a self-hosted Next.js server:
 * every request is proxied verbatim to the app, but responses that take
 * longer than GATEWAY_TIMEOUT_MS are aborted and answered with a 502 and an
 * nginx-style HTML error page (a non-JSON body, exactly like a real gateway).
 *
 * Usage: node scripts/gateway-proxy.js   → listens on :3100 → forwards :3000
 */
const http = require("http");

const PORT = 3100;
const TARGET_PORT = 3000;
const GATEWAY_TIMEOUT_MS = 60_000; // nginx proxy_read_timeout default

let counter = 0;
const server = http.createServer((req, res) => {
  const id = ++counter;
  const start = Date.now();
  const upstream = http.request(
    { host: "127.0.0.1", port: TARGET_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `localhost:${TARGET_PORT}` } },
    (up) => {
      const elapsed = Date.now() - start;
      if (elapsed > GATEWAY_TIMEOUT_MS) {
        // Headers arrived after the gateway would have given up.
        console.log(`[${id}] ${req.method} ${req.url} -> upstream responded at ${elapsed}ms but gateway already timed out`);
        up.destroy();
        return;
      }
      console.log(`[${id}] ${req.method} ${req.url} -> ${up.statusCode} (${elapsed}ms)`);
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    }
  );
  upstream.setTimeout(GATEWAY_TIMEOUT_MS, () => {
    const elapsed = Date.now() - start;
    console.log(`[${id}] GATEWAY TIMEOUT after ${elapsed}ms: ${req.method} ${req.url}`);
    upstream.destroy();
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end(`<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>gateway</center>\r\n</body>\r\n</html>\r\n`);
    }
  });
  req.pipe(upstream);
  upstream.on("error", (err) => {
    console.log(`[${id}] upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end(`<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>`);
    }
    res.end();
  });
});
server.listen(PORT, () => console.log(`gateway on :${PORT} -> :${TARGET_PORT}, timeout ${GATEWAY_TIMEOUT_MS}ms`));
