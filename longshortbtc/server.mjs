import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const ALLOWED_INTERVALS = new Set(["5m", "15m", "1h", "4h"]);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/health") {
      return send(res, 200, JSON.stringify({ status: "ok" }));
    }
    if (url.pathname === "/api/klines") {
      const interval = url.searchParams.get("interval") || "1h";
      const limit = Math.min(1000, Math.max(250, Number(url.searchParams.get("limit")) || 1000));
      if (!ALLOWED_INTERVALS.has(interval)) return send(res, 400, JSON.stringify({ error: "Temporalidad no válida" }));

      const upstream = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
      const response = await fetch(upstream, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Proveedor de datos: ${response.status}`);
      return send(res, 200, await response.text());
    }

    const requestPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safePath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(ROOT, safePath);
    if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden", "text/plain");
    const data = await readFile(filePath);
    send(res, 200, data, mime[extname(filePath)] || "application/octet-stream");
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, "Not found", "text/plain");
    send(res, 502, JSON.stringify({ error: error.message || "No se pudieron cargar los datos" }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`BTC Barometer listo en http://localhost:${PORT}`);
});
