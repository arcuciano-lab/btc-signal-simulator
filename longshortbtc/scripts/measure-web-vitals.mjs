import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const edge = process.env.CHROME_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const tempRoot = join(process.cwd(), ".tmp");
await mkdir(tempRoot, { recursive:true });
const profile = await mkdtemp(join(tempRoot, "btc-vitals-"));
const server = spawn(process.execPath, ["server.mjs"], { env:{ ...process.env, PORT:"4173" }, stdio:"ignore" });
const browser = spawn(edge, [
  "--headless",
  "--disable-gpu",
  "--no-first-run",
  "--remote-allow-origins=*",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio:["ignore", "ignore", "pipe"] });
let browserError = "";
let browserExit = null;
let resolveBrowser;
let rejectBrowser;
const browserReady = new Promise((resolve, reject) => { resolveBrowser = resolve; rejectBrowser = reject; });
browser.stderr.on("data", chunk => {
  browserError += chunk;
  const match = browserError.match(/DevTools listening on (ws:\/\/[^\s]+)/);
  if (match) resolveBrowser(match[1]);
});
browser.once("exit", (code, signal) => {
  browserExit = { code, signal };
  rejectBrowser(new Error(`Browser exited before exposing CDP (${JSON.stringify(browserExit)})`));
});
browser.once("error", error => {
  browserError += error.message;
  rejectBrowser(error);
});

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function retry(task, attempts = 50) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await task(); }
    catch (error) { lastError = error; await sleep(100); }
  }
  throw lastError;
}

let socket;
try {
  await retry(async () => {
    const response = await fetch("http://127.0.0.1:4173/health");
    if (!response.ok) throw new Error("Server is not ready");
  });
  const browserWebSocketUrl = await Promise.race([
    browserReady,
    sleep(8_000).then(() => {
      const exit = browserExit ? ` Browser exited (${JSON.stringify(browserExit)}).` : "";
      const diagnostic = browserError.trim() ? ` Browser output: ${browserError.trim()}` : "";
      throw new Error(`Timed out waiting for the browser CDP endpoint.${exit}${diagnostic}`);
    })
  ]);
  socket = new WebSocket(browserWebSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once:true });
    socket.addEventListener("error", reject, { once:true });
  });
  let id = 0;
  const pending = new Map();
  const rejectPending = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  socket.addEventListener("close", event => {
    const diagnostic = browserError.trim() ? ` Browser output: ${browserError.trim()}` : "";
    rejectPending(new Error(`CDP socket closed with commands pending (code ${event.code}, reason ${event.reason || "none"}).${diagnostic}`));
  });
  socket.addEventListener("error", () => {
    const diagnostic = browserError.trim() ? ` Browser output: ${browserError.trim()}` : "";
    rejectPending(new Error(`CDP socket failed with commands pending.${diagnostic}`));
  });
  const command = (method, params = {}, timeoutMs = 5_000, sessionId) => new Promise((resolve, reject) => {
    id += 1;
    const requestId = id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`CDP command timed out after ${timeoutMs} ms: ${method}`));
    }, timeoutMs);
    pending.set(requestId, {
      resolve:value => { clearTimeout(timer); resolve(value); },
      reject:error => { clearTimeout(timer); reject(error); }
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await command("Target.createTarget", { url:"about:blank" });
  const { sessionId } = await command("Target.attachToTarget", { targetId, flatten:true });
  await command("Page.enable", {}, 5_000, sessionId);
  await command("Page.addScriptToEvaluateOnNewDocument", { source:`
    globalThis.__webVitals = { lcp:null, cls:0 };
    new PerformanceObserver(list => {
      const entries = list.getEntries();
      if (entries.length) globalThis.__webVitals.lcp = entries.at(-1).startTime;
    }).observe({ type:"largest-contentful-paint", buffered:true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) globalThis.__webVitals.cls += entry.value;
      }
    }).observe({ type:"layout-shift", buffered:true });
  ` }, 5_000, sessionId);
  await command("Page.navigate", { url:"http://127.0.0.1:4173" }, 5_000, sessionId);
  await sleep(12_000);
  const result = await command("Runtime.evaluate", {
    returnByValue:true,
    expression:`(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const resources = performance.getEntriesByType("resource");
      const paint = Object.fromEntries(performance.getEntriesByType("paint").map(entry => [entry.name, entry.startTime]));
      const captured = globalThis.__webVitals || { lcp:null, cls:0 };
      return {
        url:location.href,
        measuredAt:new Date().toISOString(),
        webVitals:{
          fcpMs:Math.round(paint["first-contentful-paint"] || 0),
          lcpMs:captured.lcp === null ? null : Math.round(captured.lcp),
          cls:Number(captured.cls.toFixed(4)),
          ttfbMs:Math.round(navigation.responseStart),
          inpMs:null
        },
        navigation:{
          domContentLoadedMs:Math.round(navigation.domContentLoadedEventEnd),
          loadMs:Math.round(navigation.loadEventEnd),
          transferredBytes:navigation.transferSize + resources.reduce((sum, entry) => sum + entry.transferSize, 0),
          resourceCount:resources.length
        },
        note:"INP requires a real user interaction and is intentionally not synthesized."
      };
    })()`
  }, 5_000, sessionId);
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  browser.kill();
  server.kill();
  await Promise.race([
    Promise.allSettled([
      new Promise(resolve => browser.once("exit", resolve)),
      new Promise(resolve => server.once("exit", resolve))
    ]),
    sleep(2_000)
  ]);
  await rm(profile, { recursive:true, force:true, maxRetries:5, retryDelay:200 }).catch(() => {});
}
