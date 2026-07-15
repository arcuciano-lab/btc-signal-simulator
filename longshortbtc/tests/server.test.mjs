import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { parseBlsCalendar, parseEconomicCalendar, resetServerState, server } from "../server.mjs";

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
  assert.equal(page.match(/class="timeframes"/g)?.length, 1);
  assert.ok(page.indexOf("class=\"chart-card\"") < page.indexOf("class=\"timeframes\""));
  assert.ok(page.indexOf("class=\"timeframes\"") < page.indexOf("id=\"priceChart\""));
  assert.doesNotMatch(page, /market-ticker|data-candle-count/);
  assert.match(page, /LAST 120 CANDLES|\u00daLTIMAS 120 VELAS/);
  assert.match(app, /const VISIBLE_CANDLE_COUNT = 120;/);
  assert.match(app, /macd:true/);
  assert.match(app, /btc-signal-simulator-v3/);
  assert.match(app, /FIXED 10x/);
  assert.match(app, /gaps or synthetic liquidation can exceed it/);
  assert.doesNotMatch(app, /loadNewsBanner|CANDLE_COUNT_KEY/);
});

test("klines validates intervals before contacting the upstream provider", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("[]"); };
  const response = await originalFetch(`${baseUrl}/api/klines?interval=1d`);
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("Alpaca market context is cached by completed bar and exposes causal source metadata",async()=>{
  let calls=0;
  globalThis.fetch=async (url,options)=>{calls++;const parsed=new URL(url);assert.equal(parsed.hostname,"data.alpaca.markets");assert.equal(parsed.searchParams.get("symbols"),"BTC/USD");assert.equal(parsed.searchParams.get("timeframe"),"4Hour");assert.equal(parsed.searchParams.get("limit"),"43");assert.equal(parsed.searchParams.get("sort"),"asc");assert.deepEqual(options.headers,{});const now=Date.now(),step=4*60*60*1000;
    const rows=Array.from({length:10},(_,i)=>({t:new Date(now-(10-i)*step).toISOString(),o:100+i,h:102+i,l:99+i,c:101+i,v:100}));return new Response(JSON.stringify({bars:{"BTC/USD":rows}}),{status:200});};
  const first=await originalFetch(`${baseUrl}/api/market-context`),payload=await first.json();
  const second=await originalFetch(`${baseUrl}/api/market-context`);
  assert.equal(second.status,200);assert.equal(calls,1);assert.equal(payload.schemaVersion,1);assert.equal(payload.stale,false);
  assert.equal(payload.source,"Alpaca Market Data");assert.ok(payload.asOf<=payload.observedAt);assert.ok(payload.availableFrom<=payload.expiresAt);
});

test("Alpaca credentials stay server-side and use only official header names",async()=>{
  const oldId=process.env.APCA_API_KEY_ID,oldSecret=process.env.APCA_API_SECRET_KEY;process.env.APCA_API_KEY_ID="test-id";process.env.APCA_API_SECRET_KEY="test-secret";
  try{globalThis.fetch=async(_url,options)=>{assert.deepEqual(options.headers,{"APCA-API-KEY-ID":"test-id","APCA-API-SECRET-KEY":"test-secret"});return new Response(JSON.stringify({bars:{"BTC/USD":[]}}),{status:200});};
    const response=await originalFetch(`${baseUrl}/api/market-context`),payload=await response.json();assert.equal(response.status,200);assert.equal(payload.unavailable,true);assert.equal(payload.source,"Alpaca Market Data");}
  finally{if(oldId===undefined)delete process.env.APCA_API_KEY_ID;else process.env.APCA_API_KEY_ID=oldId;if(oldSecret===undefined)delete process.env.APCA_API_SECRET_KEY;else process.env.APCA_API_SECRET_KEY=oldSecret;}
});

test("partial Alpaca credentials are omitted to preserve unauthenticated access",async()=>{
  const oldId=process.env.APCA_API_KEY_ID,oldSecret=process.env.APCA_API_SECRET_KEY;
  try{for(const credentials of [{id:"id-only",secret:undefined},{id:undefined,secret:"secret-only"}]){resetServerState();if(credentials.id===undefined)delete process.env.APCA_API_KEY_ID;else process.env.APCA_API_KEY_ID=credentials.id;if(credentials.secret===undefined)delete process.env.APCA_API_SECRET_KEY;else process.env.APCA_API_SECRET_KEY=credentials.secret;
      globalThis.fetch=async(_url,options)=>{assert.deepEqual(options.headers,{});return new Response(JSON.stringify({bars:{"BTC/USD":[]}}),{status:200});};const response=await originalFetch(`${baseUrl}/api/market-context`);assert.equal(response.status,200);}}
  finally{if(oldId===undefined)delete process.env.APCA_API_KEY_ID;else process.env.APCA_API_KEY_ID=oldId;if(oldSecret===undefined)delete process.env.APCA_API_SECRET_KEY;else process.env.APCA_API_SECRET_KEY=oldSecret;}
});

test("Alpaca failure degrades to explicitly unavailable Alpaca context",async()=>{globalThis.fetch=async()=>new Response("down",{status:503});const response=await originalFetch(`${baseUrl}/api/market-context`),payload=await response.json();assert.equal(response.status,200);assert.equal(payload.stale,true);assert.equal(payload.unavailable,true);assert.equal(payload.source,"Alpaca Market Data");});

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

test("economic calendar parser reads Investing's current Next.js hydration payload", () => {
  const state = { props:{ pageProps:{ stores:{ economicCalendarStore:{ calendarEventsByDate:{ "2026-07-14":[
    { event:"IPC", suffix:"(Anual)", currency:"USD", importance:"3", time:"2026-07-14T12:30:00Z", actual:"2,7%", forecast:"2,8%", previous:"2,9%" },
    { event:"Dato medio", currency:"EUR", importance:"2", time:"2026-07-14T13:00:00Z" }
  ] } } } } } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script>`;
  assert.deepEqual(parseEconomicCalendar(html, Date.parse("2026-07-14T12:00:00Z")), [{ title:"IPC (Anual)", currency:"USD", impact:"high", timestamp:Date.parse("2026-07-14T12:30:00Z"), actual:"2,7%", forecast:"2,8%", previous:"2,9%" }]);
});

test("BLS calendar parser preserves the official US Eastern release time", () => {
  const ics = "BEGIN:VEVENT\r\nDTSTART;TZID=US-Eastern:20260714T083000\r\nSUMMARY:Consumer Price Index\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;TZID=US-Eastern:20260714T100000\r\nSUMMARY:Regional data unavailable\r\nEND:VEVENT";
  assert.deepEqual(parseBlsCalendar(ics, Date.parse("2026-07-14T00:00:00Z")), [{ title:"Consumer Price Index", currency:"USD", impact:"high", timestamp:Date.parse("2026-07-14T12:30:00Z"), actual:"", forecast:"", previous:"" }]);
});

test("BLS calendar parser applies the winter US Eastern offset", () => {
  const ics = "BEGIN:VEVENT\r\nDTSTART;TZID=US-Eastern:20260114T083000\r\nSUMMARY:Producer Price Index\r\nEND:VEVENT";
  assert.equal(parseBlsCalendar(ics, Date.parse("2026-01-14T00:00:00Z"))[0].timestamp, Date.parse("2026-01-14T13:30:00Z"));
});

test("macro endpoint degrades safely when the upstream calendar fails", async () => {
  globalThis.fetch = async () => new Response("blocked", { status:403 });
  const response = await originalFetch(`${baseUrl}/api/macro-calendar`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items:[], updatedAt:0, expiresAt:0, stale:true, source:"Investing.com / U.S. Bureau of Labor Statistics", unavailable:true });
});

test("macro endpoint falls back to the official BLS schedule", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("changed markup", { status:200 });
    return new Response("BEGIN:VEVENT\r\nDTSTART;TZID=US-Eastern:20990101T083000\r\nSUMMARY:Employment Situation\r\nEND:VEVENT", { status:200 });
  };
  const payload = await (await originalFetch(`${baseUrl}/api/macro-calendar`)).json();
  assert.equal(payload.source, "U.S. Bureau of Labor Statistics");
  assert.equal(payload.fallback, true);
  assert.equal(payload.items[0].title, "Employment Situation");
  assert.equal(calls, 2);
  const cached = await (await originalFetch(`${baseUrl}/api/macro-calendar`)).json();
  assert.equal(cached.source, "U.S. Bureau of Labor Statistics");
  assert.equal(cached.fallback, true);
  assert.equal(cached.items[0].title, "Employment Situation");
  assert.equal(calls, 2);
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



