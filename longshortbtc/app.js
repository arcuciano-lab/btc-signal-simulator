import { analyze, WEIGHTS } from "./strategy.js";

const TIMEFRAMES = ["5m", "15m", "1h", "4h"];
const TF_INFLUENCE = { "5m": .15, "15m": .20, "1h": .30, "4h": .35 };
const SIM_KEY = "btc-signal-simulator-v1";
const CHART_KEY = "btc-chart-indicators-v1";
const CANDLE_COUNT_KEY = "btc-chart-candle-count-v1";
const $ = id => document.getElementById(id);
const money = (v, digits = 0) => new Intl.NumberFormat("es-ES", { style:"currency", currency:"USD", minimumFractionDigits:digits, maximumFractionDigits:digits }).format(v);
const number = (v, d = 2) => new Intl.NumberFormat("es-ES", { minimumFractionDigits:d, maximumFractionDigits:d }).format(v);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const state = {
  tf: "1h",
  cache: {},
  currentByTf: {},
  rowsByTf: {},
  news: [],
  oil: null,
  loading: false,
  chartIndicators: loadChartPreferences(),
  candleCount: [48,72,120].includes(Number(localStorage.getItem(CANDLE_COUNT_KEY))) ? Number(localStorage.getItem(CANDLE_COUNT_KEY)) : 48,
  simulator: loadSimulator()
};

function loadChartPreferences() {
  try { return { bollinger:true, volume:true, rsi:true, macd:false, ...JSON.parse(localStorage.getItem(CHART_KEY)) }; }
  catch { return { bollinger:true, volume:true, rsi:true, macd:false }; }
}

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
  $("chartRangeLabel").textContent=`PRECIO · ÚLTIMAS ${state.candleCount} VELAS`;
  drawCharts(rows.slice(-state.candleCount));
  renderSimulator();
  renderNewsTicker();
  $("updated").textContent = `Cierre analizado: ${new Date(current.closeTime).toLocaleString("es-ES", {dateStyle:"short",timeStyle:"short"})}`;
}

async function loadNewsBanner(){
  try{const response=await fetch("/api/news");if(!response.ok)throw new Error("news");const data=await response.json();state.news=Array.isArray(data.items)?data.items:[];state.oil=data.oil||null;renderNewsTicker()}catch{renderNewsTicker()}
}

function renderNewsTicker(){
  const track=$("tickerTrack");if(!track)return;
  const market=state.currentByTf["5m"],signal=Object.keys(state.currentByTf).length===TIMEFRAMES.length?consensus():null;
  const internal=[];
  if(market)internal.push({category:"BTC",source:"MERCADO",title:`${money(market.close)} · cierre 5 min`,url:""});
  if(signal)internal.push({category:"SEÑAL",source:"SISTEMA",title:`Consenso ${signal.long} Long / ${signal.short} Short · ${signal.agreement}/4 temporalidades`,url:""});
  if(state.oil){const oil=state.oil,sign=oil.changePct>=0?"+":"";internal.push({category:"PETRÓLEO WTI",source:"CL",title:`${number(oil.price,2)} ${oil.currency} · ${sign}${number(oil.changePct)}% · cotización retrasada`,url:oil.url,priority:Math.abs(oil.changePct)>=2?"high":""})}
  const items=[...internal,...state.news];if(!items.length)return;
  track.replaceChildren();
  const appendItems=()=>items.forEach(item=>{
    const element=document.createElement(item.url?"a":"span");element.className=`ticker-item ${item.priority||""}`;if(item.url){element.href=item.url;element.target="_blank";element.rel="noopener noreferrer"}
    const tag=document.createElement("strong");tag.textContent=item.category||item.source;const title=document.createElement("span");title.textContent=item.title;element.append(tag,title);track.append(element);
    const dot=document.createElement("i");dot.setAttribute("aria-hidden","true");track.append(dot);
  });
  appendItems();appendItems();track.style.setProperty("--ticker-duration",`${Math.max(42,items.length*7)}s`);
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
  const sets=[{v:rows.map(r=>r.ema50),c:"#ffe600",w:1.4},{v:rows.map(r=>r.ema200),c:"#00d9ff",w:1.4}];
  const bandValues=state.chartIndicators.bollinger?rows.flatMap(r=>[r.bbUpper,r.bbLower]):[];
  const trade=state.simulator.position,tradeLevels=trade?[trade.entry]:[];
  const all=[...rows.flatMap(r=>[r.high,r.low]),...sets.flatMap(s=>s.v),...bandValues,...tradeLevels].filter(Number.isFinite), rawMin=Math.min(...all), rawMax=Math.max(...all), pad=(rawMax-rawMin)*.08||1, min=rawMin-pad,max=rawMax+pad;
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
  drawTradeLevel(ctx,startX,W,targetY,"#00f5a0",`TP +5%${rawTargetY<0?" ↑":rawTargetY>H?" ↓":""} · ${money(target)}`,[3,5],1);
  drawTradeLevel(ctx,startX,W,stopY,"#ff3567",`SL −2,5%${rawStopY<0?" ↑":rawStopY>H?" ↓":""} · ${money(stop)}`,[3,5],1);
  drawTradeLevel(ctx,startX,W,lineY,color,`SIM ${trade.side.toUpperCase()} · ENTRADA ${money(trade.entry)}`,[8,5],1.6,true);
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

document.querySelectorAll("[data-chart-toggle]").forEach(btn=>btn.addEventListener("click",()=>{const key=btn.dataset.chartToggle;state.chartIndicators[key]=!state.chartIndicators[key];localStorage.setItem(CHART_KEY,JSON.stringify(state.chartIndicators));if(state.lastRows)drawCharts(state.lastRows.slice(-state.candleCount))}));
document.querySelectorAll("[data-candle-count]").forEach(btn=>btn.addEventListener("click",()=>{state.candleCount=Number(btn.dataset.candleCount);localStorage.setItem(CANDLE_COUNT_KEY,state.candleCount);document.querySelectorAll("[data-candle-count]").forEach(b=>b.classList.toggle("active",Number(b.dataset.candleCount)===state.candleCount));if(state.lastRows){$("chartRangeLabel").textContent=`PRECIO · ÚLTIMAS ${state.candleCount} VELAS`;drawCharts(state.lastRows.slice(-state.candleCount))}}));
document.querySelectorAll("[data-candle-count]").forEach(btn=>btn.classList.toggle("active",Number(btn.dataset.candleCount)===state.candleCount));
window.addEventListener("resize",()=>{if(state.lastResize)clearTimeout(state.lastResize);state.lastResize=setTimeout(()=>state.lastRows&&drawCharts(state.lastRows.slice(-state.candleCount)),150)});
setInterval(() => load(state.tf, true), 60_000);
setInterval(loadNewsBanner,10*60_000);
loadNewsBanner();
load(state.tf);
