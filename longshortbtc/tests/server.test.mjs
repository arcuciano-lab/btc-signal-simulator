import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { parseEconomicCalendar, resetServerState, server } from "../server.mjs";

const originalFetch = globalThis.fetch;
let baseUrl;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => resetServerState());

after(async () => {
  globalThis.fetch = originalFetch;
  server.close();
  await once(server, "close");
});

test("static assets return a stable ETag and support revalidation", async () => {
  const first = await originalFetch(`${baseUrl}/strategy.js`);
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.equal(first.headers.get("cache-control"), "no-cache");

  const second = await originalFetch(`${baseUrl}/strategy.js`, { headers:{ "if-none-match":etag } });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
});

test("dashboard ships a fixed 120-candle chart, default MACD, and one signal banner", async () => {
  const [pageResponse, appResponse] = await Promise.all([
    originalFetch(`${baseUrl}/`),
    originalFetch(`${baseUrl}/app.js`)
  ]);
  const page = await pageResponse.text();
  const app = await appResponse.text();

  assert.match(page, /id="signalBanner"/);
  assert.doesNotMatch(page, /market-ticker|data-candle-count/);
  assert.match(page, /LAST 120 CANDLES|\u00daLTIMAS 120 VELAS/);
  assert.match(app, /const VISIBLE_CANDLE_COUNT = 120;/);
  assert.match(app, /macd:true/);
  assert.match(app, /btc-signal-simulator-v3/);
  assert.match(app, /leverageReason/);
  assert.match(app, /estimated fees and slippage on.*notional/);
  assert.doesNotMatch(app, /loadNewsBanner|CANDLE_COUNT_KEY/);
});

test("klines validates intervals before contacting the upstream provider", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("[]"); };
  const response = await originalFetch(`${baseUrl}/api/klines?interval=1d`);
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("klines truncates decimal limits and deduplicates concurrent and cached requests", async () => {
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async url => {
    calls += 1;
    assert.match(url, /interval=5m&limit=300$/);
    await pending;
    return new Response("[[1]]", { status:200 });
  };

  const first = originalFetch(`${baseUrl}/api/klines?interval=5m&limit=300.9`);
  const second = originalFetch(`${baseUrl}/api/klines?interval=5m&limit=300.9`);
  for (let attempt = 0; calls === 0 && attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(calls, 1);
  release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), ["[[1]]", "[[1]]"]);

  const cached = await originalFetch(`${baseUrl}/api/klines?interval=5m&limit=300.9`);
  assert.equal(await cached.text(), "[[1]]");
  assert.equal(calls, 1);
});

test("economic calendar parser keeps only high-impact events and normalizes values", () => {
  const html = `<table>
    <tr id="eventRowId_1" data-event-datetime="2026/07/14 14:30:00"><td class="flagCur">USD</td><td class="sentiment"><i class="grayFullBullishIcon"></i><i class="grayFullBullishIcon"></i><i class="grayFullBullishIcon"></i></td><td class="event">IPC interanual</td><td class="act">2,7%</td><td class="fore">2,8%</td><td class="prev">2,9%</td></tr>
    <tr id="eventRowId_1-copy" data-event-datetime="2026/07/14 14:30:00"><td class="flagCur">USD</td><td data-img_key="bull3"></td><td class="event">IPC interanual</td><td class="act">2,7%</td><td class="fore">2,8%</td><td class="prev">2,9%</td></tr>
    <tr id="eventRowId_2" data-event-datetime="2026/07/14 15:00:00"><td class="flagCur">EUR</td><td class="sentiment"><i class="grayFullBullishIcon"></i><i class="grayFullBullishIcon"></i></td><td class="event">Dato medio</td></tr>
    <tr id="eventRowId_3" data-event-datetime="fecha-invalida"><td class="flagCur">USD</td><td data-img_key="bull3"></td><td class="event">Sin fecha fiable</td></tr>
  </table>`;
  assert.deepEqual(parseEconomicCalendar(html, Date.parse("2026-07-14T12:00:00Z")), [{ title:"IPC interanual", currency:"USD", impact:"high", timestamp:Date.parse("2026-07-14T14:30:00"), actual:"2,7%", forecast:"2,8%", previous:"2,9%" }]);
});

test("macro endpoint degrades safely when the upstream calendar fails", async () => {
  globalThis.fetch = async () => new Response("blocked", { status:403 });
  const response = await originalFetch(`${baseUrl}/api/macro-calendar`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items:[], updatedAt:0, expiresAt:0, stale:true, source:"Investing.com", unavailable:true });
});

test("macro endpoint coalesces concurrent requests and reuses its cache", async () => {
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calendar = `<tr id="eventRowId_9" data-event-datetime="2099/01/01 10:00:00"><td class="flagCur">USD</td><td data-img_key="bull3"></td><td class="event">Decisión de tipos</td></tr>`;
  globalThis.fetch = async () => { calls += 1; await pending; return new Response(calendar, { status:200 }); };
  const first = originalFetch(`${baseUrl}/api/macro-calendar`);
  const second = originalFetch(`${baseUrl}/api/macro-calendar`);
  for (let attempt = 0; calls === 0 && attempt < 100; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  release();
  const payloads = await Promise.all([first, second].map(async request => (await request).json()));
  assert.equal(payloads[0].items[0].title, "Decisión de tipos");
  assert.equal(payloads[1].items[0].title, "Decisión de tipos");
  const cached = await (await originalFetch(`${baseUrl}/api/macro-calendar`)).json();
  assert.equal(cached.items[0].title, "Decisión de tipos");
  assert.equal(calls, 1);
});



