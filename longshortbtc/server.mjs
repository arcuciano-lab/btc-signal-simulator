import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const ALLOWED_INTERVALS = new Set(["5m", "15m", "1h", "4h"]);
const ECONOMIC_CALENDAR_URL = "https://es.investing.com/economic-calendar/";
const BLS_CALENDAR_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const NEWS_SOURCES = [
  { source:"FED", category:"MACRO", url:"https://www.federalreserve.gov/feeds/press_monetary.xml", limit:4 },
  { source:"BCE", category:"MACRO UE", url:"https://www.ecb.europa.eu/rss/press.html", limit:4 },
  { source:"BLS", category:"DATOS USA", url:"https://www.bls.gov/feed/bls_latest.rss", limit:3 },
  { source:"COINDESK", category:"BITCOIN", url:"https://www.coindesk.com/arc/outboundfeeds/rss/", limit:5 },
  { source:"BBC", category:"GEOPOLÍTICA", url:"https://feeds.bbci.co.uk/news/world/rss.xml", limit:8, filter:/war|conflict|attack|missile|military|ceasefire|sanction|iran|israel|gaza|ukraine|russia|nato|china|taiwan|red sea|oil/i },
  { source:"ONU", category:"PAZ Y SEGURIDAD", url:"https://news.un.org/feed/subscribe/en/news/topic/peace-and-security/feed/rss.xml", limit:4 }
];
let newsCache = { items:[], oil:null, expiresAt:0 };
let newsRequest = null;
let macroCache = { items:[], updatedAt:0, expiresAt:0 };
let macroRequest = null;
const klineCache = new Map();
const klineRequests = new Map();
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, status, body, type = "application/json; charset=utf-8", cacheControl = "no-store") {
  res.writeHead(status, { "content-type": type, "cache-control": cacheControl });
  res.end(body);
}

function sendStatic(req, res, data, type) {
  const etag = `"${createHash("sha256").update(data).digest("base64url")}"`;
  const headers = { "content-type": type, "cache-control": "no-cache", etag };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  res.end(data);
}

function decodeXml(value="") {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1").replace(/<[^>]+>/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&apos;|&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).replace(/\s+/g," ").trim();
}

function xmlField(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`,"i"));
    if (match) return decodeXml(match[1]);
  }
  return "";
}

function parseFeed(xml, config) {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi), ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(m=>m[0]);
  return blocks.slice(0,config.limit).map(block=>{
    const href = block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1];
    const dateText = xmlField(block,["pubDate","published","updated","dc:date"]);
    return { source:config.source, category:config.category, title:xmlField(block,["title"]), url:href||xmlField(block,["link"]), publishedAt:dateText?Date.parse(dateText)||0:0 };
  }).filter(item=>item.title&&/^https?:\/\//i.test(item.url)&&(!config.filter||config.filter.test(item.title)));
}

function stripMarkup(value = "") { return decodeXml(value.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "")); }
function calendarField(row, classPattern) {
  const match = row.match(new RegExp(`<[^>]*class=["'][^"']*(?:${classPattern})[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
  return stripMarkup(match?.[1] || "");
}
export function parseEconomicCalendar(html, now = Date.now()) {
  const rows = [...html.matchAll(/<tr\b[^>]*(?:id=["']eventRowId_[^"']+|class=["'][^"']*js-event-item[^"']*)[^>]*>[\s\S]*?<\/tr>/gi)].map(match => match[0]);
  const legacyEvents = rows.map(row => {
    const fullIcons = (row.match(/grayFullBullishIcon/gi) || []).length;
    const impact = fullIcons >= 3 || /(?:data-img_key|class)=["'][^"']*bull3\b/i.test(row) || /importance(?:Level)?=["']3["']/i.test(row) ? "high" : "";
    const currency = calendarField(row, "flagCur|left.*flag").replace(/[^A-Z]/g, "").slice(0, 3);
    const title = calendarField(row, "event") || calendarField(row, "eventTd");
    const dateText = row.match(/data-event-datetime=["']([^"']+)/i)?.[1]?.trim() || "";
    const normalizedDate = dateText.match(/^\d{4}[/-]\d{2}[/-]\d{2} \d{2}:\d{2}(?::\d{2})?$/) ? dateText.replaceAll("/", "-").replace(" ", "T") : "";
    const parsedTimestamp = normalizedDate ? Date.parse(normalizedDate) : NaN;
    const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
    return { title, currency, impact, timestamp, actual:calendarField(row, "act"), forecast:calendarField(row, "fore"), previous:calendarField(row, "prev") };
  }).filter(item => item.impact === "high" && item.title && item.timestamp !== null && item.timestamp >= now - 12 * 60 * 60 * 1000)
    .sort((a, b) => a.timestamp - b.timestamp);
  const nextData = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  let calendarEventsByDate = null;
  if (nextData) {
    try {
      const pending = [JSON.parse(nextData)];
      while (pending.length && !calendarEventsByDate) {
        const value = pending.pop();
        if (!value || typeof value !== "object") continue;
        if (value.economicCalendarStore?.calendarEventsByDate) calendarEventsByDate = value.economicCalendarStore.calendarEventsByDate;
        else pending.push(...Object.values(value));
      }
    } catch {}
  }
  const hydratedEvents = Object.values(calendarEventsByDate || {}).flat().map(event => ({
    title:[event.event, event.suffix].filter(Boolean).join(" "), currency:String(event.currency || "").toUpperCase().slice(0, 3), impact:String(event.importance) === "3" ? "high" : "",
    timestamp:Date.parse(event.actual_time || event.time), actual:String(event.actual || ""), forecast:String(event.forecast || ""), previous:String(event.previous || "")
  })).filter(item => item.impact === "high" && item.title && Number.isFinite(item.timestamp) && item.timestamp >= now - 12 * 60 * 60 * 1000);
  const events = [...legacyEvents, ...hydratedEvents].sort((a, b) => a.timestamp - b.timestamp);
  return [...new Map(events.map(item => [`${item.timestamp}\u0000${item.currency}\u0000${item.title.toLocaleLowerCase("es")}`, item])).values()].slice(0, 10);
}

function zonedTimestamp(parts, timeZone) {
  if (timeZone === "US-Eastern") timeZone = "America/New_York";
  let timestamp = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = Object.fromEntries(formatter.formatToParts(timestamp).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
    timestamp += Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
  }
  return timestamp;
}
export function parseBlsCalendar(ics, now = Date.now()) {
  // BLS publishes many specialist releases. Keep only releases that routinely
  // move rates, USD and index futures; the fallback must not invent importance.
  const marketMoving = /consumer price index|employment situation|producer price index|job openings and labor turnover survey/i;
  return [...ics.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map(match => {
    const block = match[1].replace(/\r?\n[ \t]/g, "");
    const date = block.match(/DTSTART(?:;TZID=([^:\r\n]+))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
    const title = block.match(/SUMMARY:(.*)/)?.[1]?.trim() || "";
    if (!date) return null;
    const parts = { year:+date[2], month:+date[3], day:+date[4], hour:+date[5], minute:+date[6] };
    const timestamp = date[1] ? zonedTimestamp(parts, date[1]) : Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    return { title, currency:"USD", impact:"high", timestamp, actual:"", forecast:"", previous:"" };
  }).filter(item => item && marketMoving.test(item.title) && item.timestamp >= now - 12 * 60 * 60 * 1000).sort((a, b) => a.timestamp - b.timestamp).slice(0, 10);
}
async function fetchEconomicCalendar() {
  if (macroCache.expiresAt > Date.now()) return { ...macroCache, stale:false };
  if (macroRequest) return macroRequest;
  macroRequest = (async () => {
    try {
      const response = await fetch(ECONOMIC_CALENDAR_URL, { headers:{ "user-agent":"Mozilla/5.0 (compatible; SimpleTrading/2.3)", accept:"text/html" }, signal:AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Economic calendar: ${response.status}`);
      const items = parseEconomicCalendar(await response.text());
      if (!items.length) throw new Error("Economic calendar returned no high-impact events");
      macroCache = { items, updatedAt:Date.now(), expiresAt:Date.now() + 15 * 60 * 1000, source:"Investing.com" };
      return { ...macroCache, stale:false };
    } catch {
      try {
        const response = await fetch(BLS_CALENDAR_URL, { headers:{ "user-agent":"SimpleTrading/2.3 (public economic dashboard)", accept:"text/calendar" }, signal:AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`BLS calendar: ${response.status}`);
        const items = parseBlsCalendar(await response.text());
        if (!items.length) throw new Error("BLS calendar returned no events");
        macroCache = { items, updatedAt:Date.now(), expiresAt:Date.now() + 15 * 60 * 1000, source:"U.S. Bureau of Labor Statistics", fallback:true };
        return { ...macroCache, stale:false };
      } catch { return { ...macroCache, stale:true, source:"Investing.com / U.S. Bureau of Labor Statistics", unavailable:macroCache.items.length === 0 }; }
    }
  })();
  try { return await macroRequest; } finally { macroRequest = null; }
}

async function fetchTrumpPosts(){
  const relevant=/tariff|trade|china|federal reserve|interest rate|bitcoin|crypto|war|iran|russia|ukraine|israel|gaza|oil|sanction|dollar|economy|market|nato/i;
  try{
    const headers={"user-agent":"BTC-Signal-Barometer/1.0 (+public market dashboard)","accept":"application/json"};
    const accountResponse=await fetch("https://truthsocial.com/api/v1/accounts/lookup?acct=realDonaldTrump",{headers,signal:AbortSignal.timeout(9000)});if(!accountResponse.ok)throw new Error(`Truth Social: ${accountResponse.status}`);
    const account=await accountResponse.json();const postsResponse=await fetch(`https://truthsocial.com/api/v1/accounts/${account.id}/statuses?exclude_replies=true&exclude_reblogs=true&limit=12`,{headers,signal:AbortSignal.timeout(9000)});if(!postsResponse.ok)throw new Error(`Truth Social posts: ${postsResponse.status}`);
    return (await postsResponse.json()).map(post=>({source:"TRUTH SOCIAL",category:"TRUMP",title:decodeXml(post.content),url:post.url,publishedAt:Date.parse(post.created_at)||0,priority:"high"})).filter(item=>item.title&&relevant.test(item.title)).slice(0,4);
  }catch{
    const response=await fetch("https://www.trumpstruth.org/feed",{headers:{"user-agent":"BTC-Signal-Barometer/1.0","accept":"application/rss+xml, application/xml, text/xml"},signal:AbortSignal.timeout(9000)});if(!response.ok)throw new Error(`Archivo Truth: ${response.status}`);
    return parseFeed(await response.text(),{source:"ARCHIVO TRUTH",category:"TRUMP",limit:12,filter:relevant}).slice(0,4).map(item=>({...item,priority:"high"}));
  }
}

async function fetchOil(){
  const response=await fetch("https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=5m&range=1d",{headers:{"user-agent":"Mozilla/5.0 BTC-Signal-Barometer","accept":"application/json"},signal:AbortSignal.timeout(9000)});if(!response.ok)throw new Error(`WTI: ${response.status}`);
  const result=(await response.json()).chart?.result?.[0],meta=result?.meta;if(!meta||!Number.isFinite(meta.regularMarketPrice))throw new Error("WTI sin datos");
  const previous=meta.chartPreviousClose||meta.previousClose||meta.regularMarketPrice,changePct=(meta.regularMarketPrice/previous-1)*100;
  return {symbol:"CL",name:"WTI Crude Oil",price:meta.regularMarketPrice,changePct,currency:meta.currency||"USD",updatedAt:(meta.regularMarketTime||0)*1000,delayed:true,url:"https://finance.yahoo.com/quote/CL%3DF/"};
}

async function fetchNews() {
  if (newsCache.expiresAt>Date.now()) return newsCache;
  if (newsRequest) return newsRequest;
  newsRequest = (async () => {
    const feedsPromise = Promise.allSettled(NEWS_SOURCES.map(async config=>{
      const response=await fetch(config.url,{headers:{"user-agent":"BTC-Signal-Barometer/1.0 (+public market dashboard)","accept":"application/rss+xml, application/xml, text/xml"},signal:AbortSignal.timeout(9000)});
      if(!response.ok)throw new Error(`${config.source}: ${response.status}`);
      return parseFeed(await response.text(),config);
    }));
    const extrasPromise=Promise.allSettled([fetchTrumpPosts(),fetchOil()]);
    const [results,[trumpResult,oilResult]]=await Promise.all([feedsPromise,extrasPromise]);
    const items=[...results.flatMap(result=>result.status==="fulfilled"?result.value:[]),...(trumpResult.status==="fulfilled"?trumpResult.value:[])].sort((a,b)=>b.publishedAt-a.publishedAt).slice(0,22);
    if(items.length||oilResult.status==="fulfilled")newsCache={items:items.length?items:newsCache.items,oil:oilResult.status==="fulfilled"?oilResult.value:newsCache.oil,expiresAt:Date.now()+10*60*1000};
    return newsCache;
  })();
  try {
    return await newsRequest;
  } finally {
    newsRequest = null;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/health") {
      return send(res, 200, JSON.stringify({ status: "ok" }));
    }
    if (url.pathname === "/api/news") {
      return send(res, 200, JSON.stringify(await fetchNews()));
    }
    if (url.pathname === "/api/macro-calendar") return send(res, 200, JSON.stringify(await fetchEconomicCalendar()));
    if (url.pathname === "/api/klines") {
      const interval = url.searchParams.get("interval") || "1h";
      const requestedLimit = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(1000, Math.max(250, Math.trunc(requestedLimit)))
        : 1000;
      if (!ALLOWED_INTERVALS.has(interval)) return send(res, 400, JSON.stringify({ error: "Temporalidad no válida" }));

      const cacheKey = `${interval}:${limit}`;
      const cached = klineCache.get(cacheKey);
      if (cached?.expiresAt > Date.now()) return send(res, 200, cached.body);
      let request = klineRequests.get(cacheKey);
      if (!request) {
        const upstream = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
        request = fetch(upstream, { signal: AbortSignal.timeout(12000) })
          .then(async response => {
            if (!response.ok) throw new Error(`Proveedor de datos: ${response.status}`);
            return response.text();
          });
        klineRequests.set(cacheKey, request);
        request.finally(() => klineRequests.delete(cacheKey)).catch(() => {});
      }
      const body = await request;
      klineCache.set(cacheKey, { body, expiresAt: Date.now() + 45_000 });
      return send(res, 200, body);
    }

    const requestPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safePath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(ROOT, safePath);
    if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden", "text/plain");
    const data = await readFile(filePath);
    sendStatic(req, res, data, mime[extname(filePath)] || "application/octet-stream");
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, "Not found", "text/plain");
    send(res, 502, JSON.stringify({ error: error.message || "No se pudieron cargar los datos" }));
  }
});

export function resetServerState() {
  newsCache = { items:[], oil:null, expiresAt:0 };
  newsRequest = null;
  macroCache = { items:[], updatedAt:0, expiresAt:0 };
  macroRequest = null;
  klineCache.clear();
  klineRequests.clear();
}

export { server };

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`BTC Barometer listo en http://localhost:${PORT}`);
  });
}
