import { analyze } from "./strategy.js";
import { calculateMacroImpact, classifyMacroEventScore, scoreMacroEvent } from "./macro-impact.js";
import { createSimulator, getConsensus, getMarkToMarket, isValidCandle, migrateSimulator, processSimulator as updateSimulator, TIMEFRAMES } from "./simulator.js";
import { buildInstitutionalReport, buildPatternEvidence, validatePattern } from "./institutional-intelligence.js";
const SIM_KEY = "btc-signal-simulator-v4";
const LEGACY_SIM_KEYS = ["btc-signal-simulator-v3", "btc-signal-simulator-v2", "btc-signal-simulator-v1"];
const CHART_KEY = "btc-chart-indicators-v2";
const VISIBLE_CANDLE_COUNT = 120;
const MARKET_HISTORY_LIMIT = 320;
const $ = id => document.getElementById(id);
const money = (v, digits = 0) => new Intl.NumberFormat("es-ES", { style:"currency", currency:"USD", minimumFractionDigits:digits, maximumFractionDigits:digits }).format(v);
const number = (v, d = 2) => new Intl.NumberFormat("es-ES", { minimumFractionDigits:d, maximumFractionDigits:d }).format(v);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);

function macroValue(label, value) {
  if (!value) return null;
  const span = document.createElement("span");
  span.className = "macro-value";
  span.textContent = `${label} ${value}`;
  return span;
}
let lastMacroItems = [];
function updateMacroImpact(items) {
  const impact = calculateMacroImpact(items);
  state.macroSnapshot = { ...state.macroSnapshot, score: impact.score, calculatedAt: Date.now() };
  $("macroImpactScore").textContent = impact.score;
  $("macroImpactBand").textContent = impact.label;
  $("macroImpact").className = `macro-impact ${impact.band}`;
  $("macroImpact").title = impact.explanation;
  $("macroImpactFill").style.width = `${impact.score}%`;
  const meter = $("macroImpact").querySelector('[role="meter"]');
  meter.setAttribute("aria-valuenow", String(impact.score));
  meter.setAttribute("aria-valuetext", `${impact.label}: ${impact.score} de 100. Intensidad, no direcciÃƒÆ’Ã‚Â³n.`);
}
function renderMacroItems(items) {
  const track = $("macroTickerTrack");
  track.replaceChildren();
  lastMacroItems = items;
  updateMacroImpact(lastMacroItems);
  if (!items.length) {
    const status = document.createElement("span"); status.className = "macro-ticker-status"; status.textContent = "Calendario macro no disponible temporalmente"; track.append(status); return;
  }
  const group = document.createElement("span"); group.className = "macro-ticker-group";
  items.forEach(item => {
    const scored = scoreMacroEvent(item);
    const relevance = classifyMacroEventScore(scored.score);
    const event = document.createElement("span");
    event.className = `macro-event macro-event-${relevance.band}`;
    event.setAttribute("dir", "rtl");
    const time = item.timestamp ? new Intl.DateTimeFormat("es-ES", { hour:"2-digit", minute:"2-digit" }).format(item.timestamp) : "HOY";
    const heading = document.createElement("strong"); heading.setAttribute("dir", "ltr");
    const timeText = document.createElement("bdi"); timeText.textContent = time;
    const currency = document.createElement("bdi"); currency.textContent = item.currency || "GLOBAL";
    const title = document.createElement("bdi"); title.textContent = item.title;
    heading.append(timeText, " · ", currency, " · ", title);
    const score = document.createElement("span"); score.className = "macro-event-score"; score.setAttribute("dir", "ltr"); score.textContent = `${relevance.label} · SCORE ${scored.score}/100`;
    event.append(heading, score);
    [["REAL", item.actual], ["PREV.", item.forecast], ["ANT.", item.previous]].map(([label, value]) => macroValue(label, value)).filter(Boolean).forEach(node => event.append(node));
    group.append(event);
  });
  const loopClone = group.cloneNode(true);
  loopClone.setAttribute("aria-hidden", "true");
  track.append(group, loopClone);
}
let macroImpactTimer = null;
function startMacroImpactTimer() {
  if (macroImpactTimer !== null) return;
  macroImpactTimer = setInterval(() => updateMacroImpact(lastMacroItems), 60000);
}
function stopMacroImpactTimer() {
  if (macroImpactTimer === null) return;
  clearInterval(macroImpactTimer);
  macroImpactTimer = null;
}
startMacroImpactTimer();
addEventListener("pagehide", stopMacroImpactTimer);
addEventListener("pageshow", event => { if (event.persisted) { startMacroImpactTimer(); updateMacroImpact(lastMacroItems); } });
async function loadMacroTicker() {
  try {
    const response = await fetch("/api/macro-calendar"); const payload = await response.json();
    const observedAt = Number.isFinite(payload.observedAt) ? payload.observedAt : Number.isFinite(payload.updatedAt) ? payload.updatedAt : Date.now();
    state.macroSnapshot = { score: null, source: payload.source || "unknown", stale: !response.ok || payload.stale === true,
      observedAt, asOf: Number.isFinite(payload.asOf) ? payload.asOf : observedAt, availableFrom: observedAt, updatedAt: observedAt, calculatedAt: null };
    renderMacroItems(response.ok && Array.isArray(payload.items) ? payload.items : []);
    const source = $("macroTickerSource");
    if (source && payload.source === "U.S. Bureau of Labor Statistics") { source.textContent = "BLS.GOV"; source.href = "https://www.bls.gov/schedule/news_release/"; }
    else if (source) { source.textContent = "INVESTING.COM"; source.href = "https://es.investing.com/economic-calendar/"; }
  }
  catch { state.macroSnapshot = { score: null, source: null, stale: true, observedAt: null, asOf: null, updatedAt: null, calculatedAt: Date.now() }; renderMacroItems([]); }
}

const macroTicker = document.querySelector(".macro-ticker");
const signalBanner = $("signalBanner");
if (macroTicker && signalBanner && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (!signalBanner.hidden && signalBanner.offsetHeight) macroTicker.style.setProperty("--signal-banner-height", `${signalBanner.offsetHeight}px`);
  }).observe(signalBanner);
}

const state = {
  tf: "1h",
  cache: {},
  currentByTf: {},
  rowsByTf: {},
  loading: false,
  macroSnapshot: { score: null, source: null, stale: true, observedAt: null, asOf: null, availableFrom: null, updatedAt: null, calculatedAt: null },
  chartIndicators: loadChartPreferences(),
  simulator: loadSimulator()
};

function loadChartPreferences() {
  try { return { bollinger:true, volume:true, rsi:true, macd:true, ...JSON.parse(localStorage.getItem(CHART_KEY)) }; }
  catch { return { bollinger:true, volume:true, rsi:true, macd:true }; }
}

function freshSimulator() {
  return createSimulator();
}

function loadSimulator() {
  for (const key of [SIM_KEY, ...LEGACY_SIM_KEYS]) {
    try {
      const serialized = localStorage.getItem(key);
      if (!serialized) continue;
      const simulator = migrateSimulator(JSON.parse(serialized));
      try { localStorage.setItem(SIM_KEY, JSON.stringify(simulator)); } catch {}
      return simulator;
    } catch {}
  }
  return freshSimulator();
}

function saveSimulator() {
  try { localStorage.setItem(SIM_KEY, JSON.stringify(state.simulator)); } catch {}
}

async function getCandles(tf, force = false) {
  const cached = state.cache[tf];
  if (!force && cached && Date.now() - cached.fetchedAt < 45_000) return cached.candles;
  const limit = tf === "1m" ? 1000 : MARKET_HISTORY_LIMIT;
  const response = await fetch(`/api/klines?interval=${tf}&limit=${limit}`);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "No se pudo consultar el mercado");
  const mapped = json.map(k => ({ time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5], closeTime:k[6] }));
  if (!mapped.length || mapped.some(candle => !isValidCandle(candle))) throw new Error("Invalid or incomplete candle payload");
  const candles = mapped.filter(candle => candle.closeTime < Date.now());
  if (!candles.length) throw new Error("No closed candles available");
  state.cache[tf] = { candles, fetchedAt: Date.now() };
  return candles;
}

async function load(tf, background = false) {
  if (state.loading) return;
  state.loading = true;
  if (!background) { $("loading").hidden = false; $("dashboard").hidden = true; }
  $("error").hidden = true;
  try {
    const previousSets = TIMEFRAMES.map(t => state.cache[t]?.candles);
    const settled = await Promise.allSettled(TIMEFRAMES.map(t => getCandles(t, background)));
    const failed = settled.some(result => result.status === "rejected");
    if (failed && !previousSets.every(set => Array.isArray(set) && set.length)) throw settled.find(result => result.status === "rejected").reason;
    const candleSets = failed ? previousSets : settled.map(result => result.value);
    state.staleData = failed;
    TIMEFRAMES.forEach((t, i) => {
      const rows = analyze(candleSets[i], state.simulator.weights);
      state.rowsByTf[t] = rows;
      state.currentByTf[t] = rows.at(-1);
    });

    if (!state.staleData) processSimulator();
    const activeTf = state.tf;
    const rows = state.rowsByTf[activeTf], current = rows.at(-1);
    const prior24 = rows[Math.max(0, rows.length - ({"1m":1440,"5m":288,"15m":96,"1h":24}[activeTf]))];
    $("dashboard").hidden = false;
    $("signalBanner").hidden = false;
    render(rows, current, prior24);
  } catch (error) {
    $("error").textContent = `No se pudieron cargar los datos: ${error.message}. Comprueba tu conexiÃƒÆ’Ã‚Â³n y vuelve a intentarlo.`;
    $("error").hidden = false;
  } finally {
    $("loading").hidden = true;
    state.loading = false;
  }
}

function consensus() {
  return getConsensus(state.currentByTf);
}

function processSimulator() {
  updateSimulator(state.simulator, state.currentByTf, state.rowsByTf, { macroSnapshot: state.macroSnapshot });
  saveSimulator();
}

function markToMarket() {
  return getMarkToMarket(state.simulator, state.currentByTf["1m"]);
}

function render(rows, current, prior24) {
  state.lastRows = rows;
  $("price").textContent = money(current.close);
  const change = (current.close/prior24.close-1)*100;
  $("priceChange").textContent = `${change >= 0 ? "+" : ""}${number(change)}% · ÃƒÆ’Ã‚Âºltimas 24 h`;
  $("priceChange").style.color = change >= 0 ? "var(--green)" : "var(--red)";
  $("longScore").textContent = current.long;
  $("shortScore").textContent = current.short;
  $("gaugeNeedle").style.left = `${current.long}%`;
  const dominant = current.long >= current.short ? "Long" : "Short", best = Math.max(current.long,current.short);
  const zone = best >= 75 ? "extreme" : best >= 62 ? "biased" : "neutral";
  $("signalBanner").className = `signal-banner ${zone} ${dominant.toLowerCase()}`;
  $("verdict").textContent = zone === "extreme" ? `Extreme ${dominant} zone` : zone === "biased" ? `${dominant} bias` : "Neutral zone";
  $("confidence").textContent = zone === "extreme" ? "TRADE ZONE" : zone === "biased" ? "MEDIUM CONVICTION" : "WAIT";
  $("signalNote").textContent = zone === "extreme" ? `This timeframe is in the extreme ${dominant.toLowerCase()} zone. The simulator enters only when at least three timeframes agree.` : "No extreme zone yet. The simulator remains patient and out of the market.";
  $("chartTitle").textContent = `BTC / USDT · ${labelTf(state.tf)}`;
  renderMetrics(current);
  $("chartRangeLabel").textContent=`PRECIO · ÃƒÆ’Ã…Â¡LTIMAS ${VISIBLE_CANDLE_COUNT} VELAS`;
  drawCharts(rows.slice(-VISIBLE_CANDLE_COUNT));
  renderSimulator();
  $("updated").textContent = `Cierre analizado: ${new Date(current.closeTime).toLocaleString("es-ES", {dateStyle:"short",timeStyle:"short"})}`;
}

function renderMetrics(c) {
  const weights = state.simulator.weights;
  const data = [
    ["RSI · 14", number(c.rsi,1), weights.rsi, c.parts.rsi, c.rsi>55?"Impulso comprador":c.rsi<45?"Impulso vendedor":"En equilibrio"],
    ["MACD · 12/26/9", `${c.hist>=0?"+":""}${number(c.hist,2)}`, weights.macd, c.parts.macd, c.hist>=0?"Momentum positivo":"Momentum negativo"],
    ["Volumen / media", `${number(c.volRatio,2)}ÃƒÆ’Ã¢â‚¬â€`, weights.volume, c.parts.volume, c.volRatio>=1.1?"Volumen confirma":"ConfirmaciÃƒÆ’Ã‚Â³n dÃƒÆ’Ã‚Â©bil"],
    ["Bandas Bollinger", `${number((c.close-c.bbLower)/(c.bbUpper-c.bbLower)*100,0)}%`, weights.bands, c.parts.bands, c.parts.bands>0?"Mitad superior":c.parts.bands<0?"Mitad inferior":"Zona media"],
    ["EMA 50 / EMA 200", c.ema50>c.ema200?"Alcista":"Bajista", weights.emaTrend, c.parts.emaTrend, c.ema50>c.ema200?"Estructura de tendencia +":"Estructura de tendencia ÃƒÂ¢Ã‹â€ Ã¢â‚¬â„¢"],
    ["Precio / EMA 50", c.close>c.ema50?"Por encima":"Por debajo", weights.ema50, c.parts.ema50, `${money(Math.abs(c.close-c.ema50))} de distancia`]
  ];
  $("metrics").innerHTML = data.map(([name,value,weight,part,note]) => `<article class="metric ${part>.15?"bull":part<-.15?"bear":""}"><div class="metric-top"><span class="metric-name">${name}</span><span class="metric-weight">PESO ${number(weight,1)}%</span></div><div class="metric-value">${value}</div><div class="metric-state">${note}</div></article>`).join("");
}

function renderSimulator() {
  const sim = state.simulator, signal = consensus(), mark = markToMarket();
  const closedWins = sim.trades.filter(t => t.net > 0).length;
  const totalReturn = (mark.equity / sim.initialBank - 1) * 100;
  const stats = [
    ["BANCA ACTUAL", money(mark.equity,2), totalReturn],
    ["RETORNO TOTAL", `${totalReturn>=0?"+":""}${number(totalReturn)}%`, totalReturn],
    ["TRADES CERRADOS", sim.trades.length],
    ["TASA DE ACIERTO", sim.trades.length ? `${number(closedWins/sim.trades.length*100,1)}%` : "ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â"],
    ["AJUSTES APRENDIDOS", sim.learningSteps],
    ["ESTADO", sim.riskControl?.halted ? "RISK HALT · RESET REQUIRED" : state.staleData ? "STALE · TRADING PAUSED" : sim.position ? `EN ${sim.position.side.toUpperCase()}` : sim.pendingReversal ? "REVERSAL PENDING" : "ESPERANDO"]
  ];
  $("simulatorStats").innerHTML = stats.map(([label,value,tone]) => `<div class="stat"><span>${label}</span><strong class="${tone>0?"positive":tone<0?"negative":""}">${value}</strong></div>`).join("");

  if (sim.position) {
    const p = sim.position;
    $("openPosition").className = `open-position ${p.side}`;
    const plans=(p.structuralPartials||[]).map(level=>`${level.executed?"FILLED":"PLANNED"} ${money(level.level)} (${level.reason})`).join(" · ") || "No valid structural level ahead";
    $("openPosition").innerHTML = `<div><span>${p.dataGap||state.staleData?"POSITION PAUSED":"OPEN POSITION"}</span><strong>${p.side.toUpperCase()} · ${money(p.entry)} · ${p.leverage}x</strong><small>${escapeHtml(state.staleData?"Stale aligned snapshot; no trading":leverageExplanation(p))}</small></div><div><span>REMAINING SIZE</span><strong>${number(p.remainingFraction*100,0)}%${p.partialTaken?" · PARTIAL TAKEN":""}</strong><small>10x is the minimum policy, not low risk. The 2% budget covers the estimated normal stop; gaps or liquidation can lose more.</small><small>${plans}</small></div><div><span>REALIZED P&amp;L</span><strong class="${p.realizedPnl>=0?"positive":"negative"}">${p.realizedPnl>=0?"+":""}${money(p.realizedPnl,2)}</strong></div><div><span>UNREALIZED P&amp;L</span><strong class="${mark.pnl>=0?"positive":"negative"}">${mark.pnl>=0?"+":""}${money(mark.pnl,2)} · ${number(mark.pct)}% estimated ROI</strong><small>${number(mark.assetReturn)}% asset return · estimated fees and slippage on ${p.leverage}x notional</small></div>`;
  } else {
    $("openPosition").className = "open-position waiting";
    $("openPosition").innerHTML = sim.pendingReversal
      ? `<div><span>REVERSAL PENDING</span><strong>${sim.pendingReversal.side.toUpperCase()} · ${sim.pendingReversal.score} score · ${sim.pendingReversal.agreement}/4 agreement</strong></div><div><span>EARLIEST ENTRY</span><strong>Next confirmed closed 1m candle</strong></div>`
      : `<div><span>NO POSITION</span><strong>Waiting for an extreme zone with 3/4 confirmation</strong></div>`;
  }

  $("consensusScore").textContent = `${signal.long} LONG / ${signal.short} SHORT · ${signal.agreement}/4 confirman`;
  $("timeframeSignals").innerHTML = TIMEFRAMES.map(tf => { const c=state.currentByTf[tf]; const lead=c.long>=c.short?"long":"short"; return `<div class="tf-signal ${lead}"><span>${labelTf(tf)}</span><strong>${c.long} L</strong><strong>${c.short} S</strong></div>`; }).join("");
  $("tradeCount").textContent = `${sim.trades.length} trade${sim.trades.length===1?"":"s"}`;
  renderTradeHistory(sim.trades);
  const report = $("institutionalReport");
  if (report) {
    const market = state.currentByTf["1m"];
    const patterns = buildPatternEvidence(state.rowsByTf["1m"]).map(candidate => validatePattern(candidate, sim.trades));
    report.textContent = buildInstitutionalReport({ market, simulator: sim, macroSnapshot: state.macroSnapshot, patterns });
  }
  const status = $("institutionalStatus");
  if (status) status.textContent = sim.riskControl?.halted ? "RISK HALT" : `BOUNDED RECALIBRATION · ${Math.min(sim.trades.length, 10)}/10`;
  $("simUpdated").textContent = `Actualiza cada 60 s · ${new Date().toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}`;
}

function appendCell(row, text, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text;
  row.append(cell);
  return cell;
}

function renderTradeHistory(trades) {
  const body = $("tradesBody");
  body.replaceChildren();
  if (!trades.length) {
    const row = document.createElement("tr");
    const cell = appendCell(row, "No trades yet. The simulator is waiting for a confirmed extreme signal.", "empty-trades");
    cell.colSpan = 6;
    body.append(row);
    return;
  }
  for (const trade of trades) {
    const row = document.createElement("tr");
    appendCell(row, formatDate(trade.entryTime));
    appendCell(row, `${trade.side.toUpperCase()} ? ${trade.leverage || 1}x`);
    appendCell(row, `${trade.longScore} / ${trade.shortScore}`);
    const prices = appendCell(row, `${money(trade.entry)} ? ${money(trade.exit)}`);
    for (const part of trade.partials || []) {
      const detail = document.createElement("small");
      detail.textContent = `${number(part.fraction * 100, 0)}% at ${money(part.price)} - ${part.reason}`;
      prices.append(detail);
    }
    const exit = appendCell(row, formatDate(trade.exitTime));
    const reason = document.createElement("small"); reason.textContent = trade.reason; exit.append(reason);
    const pnl = appendCell(row, `${trade.pnl >= 0 ? "+" : ""}${money(trade.pnl, 2)}`, trade.pnl >= 0 ? "positive" : "negative");
    const summary = document.createElement("small");
    summary.textContent = `Realized ? ${trade.net >= 0 ? "+" : ""}${number(trade.net * 100)}% ROI ? ${number((trade.weightedAssetReturn ?? trade.assetReturn ?? 0) * 100)}% asset`;
    pnl.append(summary);
    body.append(row);
  }
}

function leverageExplanation(position) {
  const decision = position.leverageDecision;
  if (!decision?.caps) return position.leverageReason || "Conservative leverage";
  const circuit = decision.circuitReason ? `; circuit: ${decision.circuitReason}` : "";
  return `${decision.bindingCap} cap selected ${position.leverage}x${circuit}`;
}

function formatDate(time) {
  return new Date(time).toLocaleString("es-ES", { day:"2-digit", month:"2-digit", year:"2-digit", hour:"2-digit", minute:"2-digit" });
}

function setupCanvas(id) {
  const canvas=$(id), dpr=devicePixelRatio||1, rect=canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  const ctx=canvas.getContext("2d"); ctx.scale(dpr,dpr);
  return { canvas, ctx, W:rect.width, H:rect.height };
}

function plotLine(ctx, values, min, max, W, H, color, width=1.4, glow=0) {
  ctx.beginPath();
  values.forEach((value,i)=>{if(!Number.isFinite(value))return;const x=i/Math.max(1,values.length-1)*W,y=H-(value-min)/(max-min||1)*H;ctx[i?"lineTo":"moveTo"](x,y)});
  ctx.strokeStyle=color;ctx.lineWidth=width;ctx.shadowColor=color;ctx.shadowBlur=glow;ctx.stroke();ctx.shadowBlur=0;
}

function drawCharts(rows) {
  document.querySelectorAll("[data-chart-toggle]").forEach(btn=>btn.classList.toggle("active",!!state.chartIndicators[btn.dataset.chartToggle]));
  $("volumePanel").hidden=!state.chartIndicators.volume;
  $("rsiPanel").hidden=!state.chartIndicators.rsi;
  $("macdPanel").hidden=!state.chartIndicators.macd;
  drawPriceChart(rows);
  if(state.chartIndicators.volume)drawVolumeChart(rows);
  if(state.chartIndicators.rsi)drawRsiChart(rows);
  if(state.chartIndicators.macd)drawMacdChart(rows);
}

function drawPriceChart(rows) {
  const surface=setupCanvas("priceChart"); if(!surface)return; const {ctx,W,H}=surface;
  const axisW=70, plotW=Math.max(100,W-axisW), chartH=H-22;
  const sets=[{v:rows.map(r=>r.ema50),c:"#ffe600",w:1.4},{v:rows.map(r=>r.ema200),c:"#ff3567",w:1.4}];
  const bandValues=state.chartIndicators.bollinger?rows.flatMap(r=>[r.bbUpper,r.bbLower]):[];
  const trade=state.simulator.position,tradeLevels=trade?[trade.entry]:[];
  const all=[...rows.flatMap(r=>[r.high,r.low]),...sets.flatMap(s=>s.v),...bandValues,...tradeLevels,...(trade?.structuralPartials||[]).map(p=>p.level)].filter(Number.isFinite), rawMin=Math.min(...all), rawMax=Math.max(...all), pad=(rawMax-rawMin)*.08||1, min=rawMin-pad,max=rawMax+pad;
  ctx.strokeStyle="#182127";ctx.lineWidth=1;
  for(let i=0;i<=4;i++){const gy=chartH*i/4;ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(plotW,gy);ctx.stroke()}
  for(let i=1;i<7;i++){const gx=plotW*i/7;ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,chartH);ctx.stroke()}
  ctx.font="8px DM Mono, monospace";ctx.textAlign="right";ctx.fillStyle="#71808b";for(let i=0;i<=4;i++){const value=max-(max-min)*i/4;ctx.fillText(money(value),W-5,clamp(chartH*i/4+3,9,chartH-3))}ctx.textAlign="left";
  if(state.chartIndicators.bollinger){
    const upper=rows.map(r=>r.bbUpper),lower=rows.map(r=>r.bbLower),point=(v,i)=>[i/(rows.length-1)*plotW,chartH-(v-min)/(max-min)*chartH];
    ctx.beginPath();upper.forEach((v,i)=>ctx[i?"lineTo":"moveTo"](...point(v,i)));[...lower].reverse().forEach((v,j)=>ctx.lineTo(...point(v,rows.length-1-j)));ctx.closePath();ctx.fillStyle="#8b5cf614";ctx.fill();
    plotLine(ctx,upper,min,max,plotW,chartH,"#278bd8",1,2);plotLine(ctx,lower,min,max,plotW,chartH,"#278bd8",1,2);
  }
  const slot=plotW/rows.length,bodyW=clamp(slot*.68,2.5,13),y=v=>chartH-(v-min)/(max-min)*chartH;
  rows.forEach((r,i)=>{
    const x=(i+.5)*slot,color=r.close>=r.open?"#00f5a0":"#ff3567",openY=y(r.open),closeY=y(r.close),highY=y(r.high),lowY=y(r.low);
    ctx.strokeStyle=color;ctx.lineWidth=1;ctx.shadowColor=color;ctx.shadowBlur=6;ctx.beginPath();ctx.moveTo(x,highY);ctx.lineTo(x,lowY);ctx.stroke();
    const top=Math.min(openY,closeY),height=Math.max(1,Math.abs(closeY-openY));ctx.fillStyle=color;ctx.shadowBlur=9;ctx.fillRect(x-bodyW/2,top,bodyW,height);ctx.shadowBlur=0;
  });
  sets.forEach(s=>plotLine(ctx,s.v,min,max,plotW,chartH,s.c,s.w,s.w>1.5?5:2));
  const last=rows.at(-1),lastY=y(last.close);ctx.setLineDash([2,3]);ctx.strokeStyle=last.close>=last.open?"#00f5a088":"#ff356788";ctx.beginPath();ctx.moveTo(0,lastY);ctx.lineTo(plotW,lastY);ctx.stroke();ctx.setLineDash([]);const priceLabel=number(last.close,1),labelW=64;ctx.fillStyle=last.close>=last.open?"#00b979":"#d82955";ctx.fillRect(plotW+3,clamp(lastY-9,0,chartH-18),labelW,18);ctx.fillStyle="#fff";ctx.font="500 8px DM Mono, monospace";ctx.fillText(priceLabel,plotW+7,clamp(lastY+3,12,chartH-5));
  const timeStep=Math.max(1,Math.floor(rows.length/6));ctx.fillStyle="#65727c";ctx.font="8px DM Mono, monospace";rows.forEach((r,i)=>{if(i%timeStep!==0&&i!==rows.length-1)return;const x=(i+.5)*slot;ctx.fillText(new Date(r.closeTime).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"}),clamp(x-16,0,plotW-34),H-5)});
  drawOpenTradeLine(ctx,rows,min,max,plotW,chartH,slot);
}

function drawOpenTradeLine(ctx,rows,min,max,W,H,slot){
  const trade=state.simulator.position;if(!trade)return;
  const color=trade.side==="long"?"#00f5a0":"#ff3567",lineY=H-(trade.entry-min)/(max-min)*H,target=trade.side==="long"?trade.entry*1.05:trade.entry*.95,stop=trade.side==="long"?trade.entry*.975:trade.entry*1.025,rawTargetY=H-(target-min)/(max-min)*H,rawStopY=H-(stop-min)/(max-min)*H,targetY=clamp(rawTargetY,3,H-3),stopY=clamp(rawStopY,3,H-3);
  const entryIndex=rows.findIndex(r=>r.closeTime>=trade.entryTime),startX=entryIndex>=0?(entryIndex+.5)*slot:0;
  ctx.save();
  ctx.fillStyle="#00f5a00d";ctx.fillRect(startX,Math.min(lineY,targetY),W-startX,Math.abs(targetY-lineY));ctx.fillStyle="#ff35670d";ctx.fillRect(startX,Math.min(lineY,stopY),W-startX,Math.abs(stopY-lineY));
  drawTradeLevel(ctx,startX,W,targetY,"#00f5a0",`TP +5% asset · est. +${number(4.7*trade.leverage,1)}% ROI${rawTargetY<0?" ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Ëœ":rawTargetY>H?" ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Å“":""}`,[3,5],1);
  drawTradeLevel(ctx,startX,W,stopY,"#ff3567",`SL ÃƒÂ¢Ã‹â€ Ã¢â‚¬â„¢2.5% asset · est. ÃƒÂ¢Ã‹â€ Ã¢â‚¬â„¢${number(2.8*trade.leverage,1)}% ROI${rawStopY<0?" ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Ëœ":rawStopY>H?" ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Å“":""}`,[3,5],1);
  drawTradeLevel(ctx,startX,W,lineY,color,`SIM ${trade.side.toUpperCase()} · ENTRADA ${money(trade.entry)}`,[8,5],1.6,true);
  (trade.structuralPartials||[]).forEach(plan=>{const py=clamp(H-(plan.level-min)/(max-min)*H,3,H-3);drawTradeLevel(ctx,startX,W,py,plan.executed?"#71808b":"#ffcc00",`${plan.executed?"FILLED":"PARTIAL 25%"} · ${plan.reason} · ${money(plan.level)}`,[2,4],1)});
  ctx.restore();
}

function drawTradeLevel(ctx,startX,endX,y,color,label,dash,width,boxed=false){
  ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.shadowColor=color;ctx.shadowBlur=boxed?11:7;ctx.beginPath();ctx.moveTo(startX,y);ctx.lineTo(endX,y);ctx.stroke();ctx.setLineDash([]);ctx.shadowBlur=0;ctx.font=`500 ${boxed?9:8}px DM Mono, monospace`;
  const labelW=ctx.measureText(label).width+14,labelX=clamp(startX+7,4,endX-labelW-4),labelY=clamp(y-(boxed?22:18),3,Math.max(3,ctx.canvas.getBoundingClientRect().height-18));ctx.fillStyle="#030506e8";ctx.fillRect(labelX,labelY,labelW,16);if(boxed){ctx.strokeStyle=color;ctx.strokeRect(labelX,labelY,labelW,16)}ctx.fillStyle=color;ctx.fillText(label,labelX+7,labelY+11);
}

function drawVolumeChart(rows){
  const surface=setupCanvas("volumeChart");if(!surface)return;const{ctx,W,H}=surface,max=Math.max(...rows.map(r=>r.volume))||1,barW=Math.max(1,W/rows.length*.62);
  rows.forEach((r,i)=>{const h=r.volume/max*(H-4),x=i/rows.length*W;ctx.fillStyle=r.close>=r.open?"#00f5a088":"#ff356788";ctx.fillRect(x,H-h,barW,h)});
}

function drawRsiChart(rows){
  const surface=setupCanvas("rsiChart");if(!surface)return;const{ctx,W,H}=surface,values=rows.map(r=>r.rsi);
  ctx.fillStyle="#ff35670d";ctx.fillRect(0,0,W,H*.30);ctx.fillStyle="#00f5a00d";ctx.fillRect(0,H*.70,W,H*.30);
  [30,50,70].forEach(v=>{const y=H-v/100*H;ctx.setLineDash(v===50?[2,5]:[5,5]);ctx.strokeStyle=v===50?"#202931":v===70?"#ff356766":"#00f5a066";ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke()});ctx.setLineDash([]);
  plotLine(ctx,values,0,100,W,H,"#00d9ff",1.5,4);
}

function drawMacdChart(rows){
  const surface=setupCanvas("macdChart");if(!surface)return;const{ctx,W,H}=surface,macd=rows.map(r=>r.macd),signal=rows.map(r=>r.macdSignal),hist=rows.map(r=>r.hist),abs=Math.max(...[...macd,...signal,...hist].filter(Number.isFinite).map(Math.abs))||1,min=-abs,max=abs,zero=H/2,barW=Math.max(1,W/rows.length*.58);
  ctx.strokeStyle="#38434c";ctx.beginPath();ctx.moveTo(0,zero);ctx.lineTo(W,zero);ctx.stroke();
  hist.forEach((v,i)=>{const y=H-(v-min)/(max-min)*H;ctx.fillStyle=v>=0?"#00f5a077":"#ff356777";ctx.fillRect(i/rows.length*W,Math.min(y,zero),barW,Math.abs(zero-y))});
  plotLine(ctx,macd,min,max,W,H,"#00d9ff",1.3,3);plotLine(ctx,signal,min,max,W,H,"#ff4fd8",1.2,3);
}

function labelTf(tf){return ({"1m":"1 min","5m":"5 min","15m":"15 min","1h":"1 hora"})[tf]}

document.querySelectorAll("[data-tf]").forEach(btn => btn.addEventListener("click", () => {
  document.querySelector("[data-tf].active").classList.remove("active");
  btn.classList.add("active");
  state.tf=btn.dataset.tf;
  load(state.tf);
}));

$("resetSimulator").addEventListener("click", () => {
  if (!confirm("Ãƒâ€šÃ‚Â¿Reiniciar la banca a 1.000 USDT y borrar todos los trades y aprendizajes?")) return;
  state.simulator = freshSimulator();
  saveSimulator();
  state.cache = {};
  load(state.tf);
});

document.querySelectorAll("[data-chart-toggle]").forEach(btn=>btn.addEventListener("click",()=>{const key=btn.dataset.chartToggle;state.chartIndicators[key]=!state.chartIndicators[key];localStorage.setItem(CHART_KEY,JSON.stringify(state.chartIndicators));if(state.lastRows)drawCharts(state.lastRows.slice(-VISIBLE_CANDLE_COUNT))}));
window.addEventListener("resize",()=>{if(state.lastResize)clearTimeout(state.lastResize);state.lastResize=setTimeout(()=>state.lastRows&&drawCharts(state.lastRows.slice(-VISIBLE_CANDLE_COUNT)),150)});
setInterval(() => load(state.tf, true), 60_000);
setInterval(loadMacroTicker, 15 * 60_000);
loadMacroTicker();
load(state.tf);


