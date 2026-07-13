import { analyze, WEIGHTS } from "./strategy.js";

const TIMEFRAMES = ["5m", "15m", "1h", "4h"];
const TF_INFLUENCE = { "5m": .15, "15m": .20, "1h": .30, "4h": .35 };
const SIM_KEY = "btc-signal-simulator-v1";
const $ = id => document.getElementById(id);
const money = (v, digits = 0) => new Intl.NumberFormat("es-ES", { style:"currency", currency:"USD", minimumFractionDigits:digits, maximumFractionDigits:digits }).format(v);
const number = (v, d = 2) => new Intl.NumberFormat("es-ES", { minimumFractionDigits:d, maximumFractionDigits:d }).format(v);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const state = {
  tf: "1h",
  cache: {},
  currentByTf: {},
  rowsByTf: {},
  loading: false,
  simulator: loadSimulator()
};

function freshSimulator() {
  return {
    initialBank: 1000,
    bank: 1000,
    position: null,
    trades: [],
    weights: { ...WEIGHTS },
    learningSteps: 0,
    lastEntryKey: null,
    startedAt: Date.now()
  };
}

function loadSimulator() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIM_KEY));
    if (saved && Number.isFinite(saved.bank) && saved.weights) return { ...freshSimulator(), ...saved };
  } catch {}
  return freshSimulator();
}

function saveSimulator() {
  localStorage.setItem(SIM_KEY, JSON.stringify(state.simulator));
}

async function getCandles(tf, force = false) {
  const cached = state.cache[tf];
  if (!force && cached && Date.now() - cached.fetchedAt < 45_000) return cached.candles;
  const response = await fetch(`/api/klines?interval=${tf}&limit=1000`);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "No se pudo consultar el mercado");
  const candles = json
    .map(k => ({ time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5], closeTime:k[6] }))
    .filter(c => c.closeTime < Date.now());
  state.cache[tf] = { candles, fetchedAt: Date.now() };
  return candles;
}

async function load(tf, background = false) {
  if (state.loading) return;
  state.loading = true;
  if (!background) { $("loading").hidden = false; $("dashboard").hidden = true; }
  $("error").hidden = true;
  try {
    const candleSets = await Promise.all(TIMEFRAMES.map(t => getCandles(t, background)));
    TIMEFRAMES.forEach((t, i) => {
      const rows = analyze(candleSets[i], state.simulator.weights);
      state.rowsByTf[t] = rows;
      state.currentByTf[t] = rows.at(-1);
    });

    processSimulator();
    const rows = state.rowsByTf[tf], current = rows.at(-1);
    const prior24 = rows[Math.max(0, rows.length - ({"5m":288,"15m":96,"1h":24,"4h":6}[tf]))];
    $("dashboard").hidden = false;
    render(rows, current, prior24);
  } catch (error) {
    $("error").textContent = `No se pudieron cargar los datos: ${error.message}. Comprueba tu conexión y vuelve a intentarlo.`;
    $("error").hidden = false;
  } finally {
    $("loading").hidden = true;
    state.loading = false;
  }
}

function consensus() {
  let long = 0;
  for (const tf of TIMEFRAMES) long += state.currentByTf[tf].long * TF_INFLUENCE[tf];
  long = Math.round(long);
  const short = 100 - long;
  const side = long >= short ? "long" : "short";
  const agreement = TIMEFRAMES.filter(tf => state.currentByTf[tf][side] >= 60).length;
  const parts = {};
  for (const key of Object.keys(WEIGHTS)) {
    parts[key] = TIMEFRAMES.reduce((sum, tf) => sum + state.currentByTf[tf].parts[key] * TF_INFLUENCE[tf], 0);
  }
  return { long, short, side, agreement, parts };
}

function processSimulator() {
  const sim = state.simulator;
  const signal = consensus();
  const market = state.currentByTf["5m"];

  if (sim.position) {
    const p = sim.position;
    const completed = state.rowsByTf["5m"].filter(c => c.time >= p.entryTime);
    let exit = null;
    for (const bar of completed) {
      const stopPrice = p.side === "long" ? p.entry * .975 : p.entry * 1.025;
      const targetPrice = p.side === "long" ? p.entry * 1.05 : p.entry * .95;
      const stopHit = p.side === "long" ? bar.low <= stopPrice : bar.high >= stopPrice;
      const targetHit = p.side === "long" ? bar.high >= targetPrice : bar.low <= targetPrice;
      if (stopHit) { exit = { price:stopPrice, time:bar.closeTime, reason:"Stop 2,5%" }; break; }
      if (targetHit) { exit = { price:targetPrice, time:bar.closeTime, reason:"Objetivo 5%" }; break; }
    }
    const opposite = p.side === "long" ? signal.short : signal.long;
    const oppositeAgreement = TIMEFRAMES.filter(tf => state.currentByTf[tf][p.side === "long" ? "short" : "long"] >= 60).length;
    if (!exit && opposite >= 62 && oppositeAgreement >= 3) exit = { price:market.close, time:market.closeTime, reason:"Señal contraria" };
    if (exit) closeTrade(exit);
  }

  if (!sim.position) {
    const extreme = Math.max(signal.long, signal.short) >= 75 && signal.agreement >= 3;
    const entryKey = `${market.closeTime}-${signal.side}`;
    if (extreme && sim.lastEntryKey !== entryKey) {
      sim.position = {
        side: signal.side,
        entry: market.close,
        entryTime: market.closeTime,
        longScore: signal.long,
        shortScore: signal.short,
        agreement: signal.agreement,
        parts: signal.parts,
        timeframeScores: Object.fromEntries(TIMEFRAMES.map(tf => [tf, { long:state.currentByTf[tf].long, short:state.currentByTf[tf].short }]))
      };
      sim.lastEntryKey = entryKey;
      saveSimulator();
    }
  }
}

function closeTrade(exit) {
  const sim = state.simulator, p = sim.position;
  const gross = p.side === "long" ? exit.price / p.entry - 1 : p.entry / exit.price - 1;
  const net = gross - .002;
  const pnl = sim.bank * net;
  sim.bank = Math.max(0, sim.bank + pnl);
  const trade = { ...p, exit:exit.price, exitTime:exit.time, reason:exit.reason, gross, net, pnl, bankAfter:sim.bank };
  sim.trades.unshift(trade);
  sim.trades = sim.trades.slice(0, 200);
  sim.position = null;
  learnFromTrade(trade);
  saveSimulator();
}

function learnFromTrade(trade) {
  const sim = state.simulator;
  const outcome = trade.net > 0 ? 1 : -1;
  const direction = trade.side === "long" ? 1 : -1;
  const adjusted = {};
  for (const key of Object.keys(WEIGHTS)) {
    const alignment = clamp(trade.parts[key] * direction, -1, 1);
    const factor = 1 + .04 * outcome * alignment;
    adjusted[key] = clamp(sim.weights[key] * factor, WEIGHTS[key] * .60, WEIGHTS[key] * 1.40);
  }
  const total = Object.values(adjusted).reduce((a,b) => a+b, 0);
  for (const key of Object.keys(adjusted)) sim.weights[key] = adjusted[key] / total * 100;
  sim.learningSteps += 1;
}

function markToMarket() {
  const sim = state.simulator;
  if (!sim.position || !state.currentByTf["5m"]) return { equity:sim.bank, pnl:0, pct:0 };
  const price = state.currentByTf["5m"].close;
  const gross = sim.position.side === "long" ? price / sim.position.entry - 1 : sim.position.entry / price - 1;
  const net = gross - .002;
  return { equity:sim.bank*(1+net), pnl:sim.bank*net, pct:net*100 };
}

function render(rows, current, prior24) {
  state.lastRows = rows;
  $("price").textContent = money(current.close);
  const change = (current.close/prior24.close-1)*100;
  $("priceChange").textContent = `${change >= 0 ? "+" : ""}${number(change)}% · últimas 24 h`;
  $("priceChange").style.color = change >= 0 ? "var(--green)" : "var(--red)";
  $("longScore").textContent = current.long;
  $("shortScore").textContent = current.short;
  $("gaugeNeedle").style.left = `${current.long}%`;
  const dominant = current.long >= current.short ? "Long" : "Short", best = Math.max(current.long,current.short);
  $("verdict").textContent = best >= 75 ? `Zona extrema ${dominant}` : best >= 62 ? `Sesgo ${dominant}` : "Zona neutral";
  $("confidence").textContent = best >= 75 ? "ZONA DE TRADE" : best >= 62 ? "CONVICCIÓN MEDIA" : "ESPERAR";
  $("signalNote").textContent = best >= 75 ? `Esta temporalidad está en zona extrema ${dominant.toLowerCase()}. El simulador solo entrará si existe confluencia en al menos tres temporalidades.` : "Todavía no hay una zona extrema. El simulador permanece paciente y sin posición.";
  $("chartTitle").textContent = `BTC / USDT · ${labelTf(state.tf)}`;
  renderMetrics(current);
  drawPriceChart(rows.slice(-120));
  renderSimulator();
  $("updated").textContent = `Cierre analizado: ${new Date(current.closeTime).toLocaleString("es-ES", {dateStyle:"short",timeStyle:"short"})}`;
}

function renderMetrics(c) {
  const weights = state.simulator.weights;
  const data = [
    ["RSI · 14", number(c.rsi,1), weights.rsi, c.parts.rsi, c.rsi>55?"Impulso comprador":c.rsi<45?"Impulso vendedor":"En equilibrio"],
    ["MACD · 12/26/9", `${c.hist>=0?"+":""}${number(c.hist,2)}`, weights.macd, c.parts.macd, c.hist>=0?"Momentum positivo":"Momentum negativo"],
    ["Volumen / media", `${number(c.volRatio,2)}×`, weights.volume, c.parts.volume, c.volRatio>=1.1?"Volumen confirma":"Confirmación débil"],
    ["Bandas Bollinger", `${number((c.close-c.bbLower)/(c.bbUpper-c.bbLower)*100,0)}%`, weights.bands, c.parts.bands, c.parts.bands>0?"Mitad superior":c.parts.bands<0?"Mitad inferior":"Zona media"],
    ["EMA 50 / EMA 200", c.ema50>c.ema200?"Alcista":"Bajista", weights.emaTrend, c.parts.emaTrend, c.ema50>c.ema200?"Estructura de tendencia +":"Estructura de tendencia −"],
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
    ["TASA DE ACIERTO", sim.trades.length ? `${number(closedWins/sim.trades.length*100,1)}%` : "—"],
    ["AJUSTES APRENDIDOS", sim.learningSteps],
    ["ESTADO", sim.position ? `EN ${sim.position.side.toUpperCase()}` : "ESPERANDO"]
  ];
  $("simulatorStats").innerHTML = stats.map(([label,value,tone]) => `<div class="stat"><span>${label}</span><strong class="${tone>0?"positive":tone<0?"negative":""}">${value}</strong></div>`).join("");

  if (sim.position) {
    const p = sim.position;
    $("openPosition").className = `open-position ${p.side}`;
    $("openPosition").innerHTML = `<div><span>POSICIÓN ABIERTA</span><strong>${p.side.toUpperCase()} · ${money(p.entry)}</strong></div><div><span>FECHA DE ENTRADA</span><strong>${formatDate(p.entryTime)}</strong></div><div><span>SCORE DE ENTRADA</span><strong>${p.longScore} L / ${p.shortScore} S</strong></div><div><span>P&amp;L FLOTANTE</span><strong class="${mark.pnl>=0?"positive":"negative"}">${mark.pnl>=0?"+":""}${money(mark.pnl,2)} · ${number(mark.pct)}%</strong></div>`;
  } else {
    $("openPosition").className = "open-position waiting";
    $("openPosition").innerHTML = `<div><span>SIN POSICIÓN</span><strong>Esperando zona extrema y confirmación 3/4</strong></div>`;
  }

  $("consensusScore").textContent = `${signal.long} LONG / ${signal.short} SHORT · ${signal.agreement}/4 confirman`;
  $("timeframeSignals").innerHTML = TIMEFRAMES.map(tf => { const c=state.currentByTf[tf]; const lead=c.long>=c.short?"long":"short"; return `<div class="tf-signal ${lead}"><span>${labelTf(tf)}</span><strong>${c.long} L</strong><strong>${c.short} S</strong></div>`; }).join("");
  $("tradeCount").textContent = `${sim.trades.length} trade${sim.trades.length===1?"":"s"}`;
  $("tradesBody").innerHTML = sim.trades.length ? sim.trades.map(t => `<tr><td>${formatDate(t.entryTime)}</td><td><span class="trade-side ${t.side}">${t.side.toUpperCase()}</span></td><td>${t.longScore} / ${t.shortScore}</td><td>${money(t.entry)} → ${money(t.exit)}</td><td>${formatDate(t.exitTime)}<small>${t.reason}</small></td><td class="${t.pnl>=0?"positive":"negative"}">${t.pnl>=0?"+":""}${money(t.pnl,2)}<small>${t.net>=0?"+":""}${number(t.net*100)}%</small></td></tr>`).join("") : `<tr><td colspan="6" class="empty-trades">Aún no hay operaciones. El simulador esperará una señal extrema real.</td></tr>`;
  $("simUpdated").textContent = `Actualiza cada 60 s · ${new Date().toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}`;
}

function formatDate(time) {
  return new Date(time).toLocaleString("es-ES", { day:"2-digit", month:"2-digit", year:"2-digit", hour:"2-digit", minute:"2-digit" });
}

function drawPriceChart(rows) {
  const canvas=$("priceChart"), dpr=devicePixelRatio||1, rect=canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr; const ctx=canvas.getContext("2d"); ctx.scale(dpr,dpr);
  const sets=[{v:rows.map(r=>r.close),c:"#f7fbff",w:2},{v:rows.map(r=>r.ema50),c:"#ffe600",w:1.4},{v:rows.map(r=>r.ema200),c:"#00f5a0",w:1.4}];
  const all=sets.flatMap(s=>s.v).filter(Number.isFinite), min=Math.min(...all), max=Math.max(...all), pad=(max-min)*.1||1, W=rect.width,H=rect.height;
  ctx.strokeStyle="#202931";ctx.lineWidth=1;for(let i=1;i<4;i++){ctx.beginPath();ctx.moveTo(0,H*i/4);ctx.lineTo(W,H*i/4);ctx.stroke()}
  sets.forEach(s=>{ctx.beginPath();s.v.forEach((v,i)=>{const x=i/(s.v.length-1)*W,y=H-(v-(min-pad))/(max-min+pad*2)*H;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.strokeStyle=s.c;ctx.lineWidth=s.w;ctx.shadowColor=s.c;ctx.shadowBlur=s.w>1.5?5:2;ctx.stroke();ctx.shadowBlur=0;});
}

function labelTf(tf){return ({"5m":"5 min","15m":"15 min","1h":"1 hora","4h":"4 horas"})[tf]}

document.querySelectorAll("[data-tf]").forEach(btn => btn.addEventListener("click", () => {
  document.querySelector("[data-tf].active").classList.remove("active");
  btn.classList.add("active");
  state.tf=btn.dataset.tf;
  load(state.tf);
}));

$("resetSimulator").addEventListener("click", () => {
  if (!confirm("¿Reiniciar la banca a 1.000 USDT y borrar todos los trades y aprendizajes?")) return;
  state.simulator = freshSimulator();
  saveSimulator();
  state.cache = {};
  load(state.tf);
});

window.addEventListener("resize",()=>{if(state.lastResize)clearTimeout(state.lastResize);state.lastResize=setTimeout(()=>state.lastRows&&drawPriceChart(state.lastRows.slice(-120)),150)});
setInterval(() => load(state.tf, true), 60_000);
load(state.tf);
