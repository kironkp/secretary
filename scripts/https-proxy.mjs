// HTTPS front-door for dev-over-Tailscale, standing in for `tailscale serve`
// (broken in the App Store Tailscale build). Terminates TLS with the cert from
// `tailscale cert` and proxies everything — including websockets (HMR) — to the
// Next dev server. Usage: npm run https-proxy   (Ctrl-C to stop)
import { readFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";
import net from "node:net";

const HOST = "kironkps-macbook-pro-1.taildfcf4.ts.net";
const PORT = 8443;
const TARGET = 3000;
const CERT_DIR = new URL("../.certs/", import.meta.url).pathname;

const tls = {
  cert: readFileSync(`${CERT_DIR}${HOST}.crt`),
  key: readFileSync(`${CERT_DIR}${HOST}.key`),
};

const server = https.createServer(tls, (req, res) => {
  const proxied = http.request(
    { host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    }
  );
  proxied.on("error", () => {
    res.writeHead(502);
    res.end("Dev server isn't running on :" + TARGET);
  });
  req.pipe(proxied);
});

// Websocket passthrough (Next HMR)
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(TARGET, "127.0.0.1", () => {
    const headerLines = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`
    );
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, () => {
  console.log(`HTTPS proxy up: https://${HOST}:${PORT} → http://localhost:${TARGET}`);
});
