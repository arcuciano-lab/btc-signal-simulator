import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSimulator, migrateSimulator, processSimulator, RECENT_MEMORY, TIMEFRAMES, TOTAL_MEMORY, weightsFromTradeMemory } from "../simulator.js";
import { buildInstitutionalReport, validatePattern } from "../institutional-intelligence.js";

const parts = { rsi:.2, macd:.2, volume:.2, bands:.2, emaTrend:.2, ema50:.2 };
const current = (score, closeTime, close=100) => Object.fromEntries(TIMEFRAMES.map(tf => [tf, { long:score, short:100-score, parts, close, closeTime }]));
const candle = closeTime => ({ time:closeTime-59999, closeTime, open:100, high:101, low:99, close:100 });
const rows = closeTime => ({ "1m":[candle(closeTime)] });

test("weak 1m setup requires fresh high macro intensity and records immutable audit facts", () => {
  const fresh=createSimulator();
  processSimulator(fresh,current(70,120000),rows(120000),{now:120001,macroSnapshot:{score:80,updatedAt:119000,source:"calendar",stale:false}});
  assert.ok(fresh.position); assert.equal(fresh.position.decisionSnapshot.macro.eligible,true);
  assert.equal(fresh.position.decisionSnapshot.policy,"macro-intensity-eligibility-not-direction");
  const stale=createSimulator(); processSimulator(stale,current(70,120000),rows(120000),{now:120001,macroSnapshot:{score:99,updatedAt:-2000000,source:"calendar",stale:false}}); assert.equal(stale.position,null);
  const missing=createSimulator(); processSimulator(missing,current(70,120000),rows(120000),{now:120001}); assert.equal(missing.position,null); assert.equal(missing.decisionSnapshots[0].macro.status,"missing");
});

test("migration retains newest thousand once, evicts 1001st and rebuilds learning fields", () => {
  const trades=Array.from({length:1001},(_,i)=>({side:"long",entry:100,net:i/100000,pnl:1,exitTime:1001-i,parts,learning:{weightsAfter:{rsi:999}}}));
  const migrated=migrateSimulator({bank:1000,weights:{rsi:15,macd:22,volume:13,bands:15,emaTrend:20,ema50:15},trades});
  assert.equal(TOTAL_MEMORY,1000); assert.equal(RECENT_MEMORY,100); assert.equal(migrated.trades.length,1000);
  assert.equal(migrated.trades[0].exitTime,1001); assert.equal(migrated.trades.at(-1).exitTime,2);
  assert.equal(migrated.trades.some(t=>t.exitTime===1),false); assert.equal(migrated.trades[0].evidenceAvailability,"unavailable-after-migration");
  assert.equal(migrated.trades[0].learning,undefined);
});

test("migration sorts by validated completion time before capping with stable ties", () => {
  const trades=Array.from({length:1001},(_,i)=>({side:"long",entry:100,net:.01,pnl:1,exitTime:i+1,marker:i}));
  trades.push({side:"long",entry:100,net:.01,pnl:1,exitTime:1001,marker:"stable-tie"},{side:"long",entry:100,net:.01,pnl:1,exitTime:NaN,marker:"invalid"});
  const migrated=migrateSimulator({bank:1000,weights:{rsi:15,macd:22,volume:13,bands:15,emaTrend:20,ema50:15},trades});
  assert.equal(migrated.trades.length,1000); assert.equal(migrated.trades[0].marker,1000);
  assert.equal(migrated.trades[1].marker,"stable-tie"); assert.equal(migrated.trades.at(-1).exitTime,3);
  assert.equal(migrated.trades.some(t=>t.marker==="invalid"||t.exitTime===1),false);
});

test("migration discards forged causal attribution and cannot manufacture weights or pattern compatibility", () => {
  const forged=Array.from({length:100},(_,i)=>({side:"long",entry:100,exitTime:100-i,net:.05,pnl:5,
    parts:{rsi:1},candidateIds:["ema-alignment"],decisionSnapshot:{candidateIds:["ema-alignment"],parts:{rsi:1}},learning:{weightsAfter:{rsi:999}}}));
  const migrated=migrateSimulator({bank:1000,weights:{rsi:15,macd:22,volume:13,bands:15,emaTrend:20,ema50:15},trades:forged});
  assert.deepEqual(migrated.weights,weightsFromTradeMemory([])); assert.ok(migrated.trades.every(t=>Object.keys(t.parts).length===0&&t.candidateIds.length===0));
  assert.ok(migrated.trades.every(t=>t.evidenceAvailability==="unavailable-after-migration"&&!t.decisionSnapshot));
  const candidate={id:"ema-alignment",name:"ema",occurrences:100,outcomes:100,netExpectancyAfterCosts:.05,successRate:1,noLookahead:true};
  assert.equal(validatePattern(candidate,migrated.trades).status,"insufficient evidence");
});

test("valid canonical causal evidence survives a storage round trip", () => {
  const simulator=createSimulator();
  processSimulator(simulator,current(90,60000),rows(60000),{now:60001});
  const stopped={"1m":[{time:60001,closeTime:120000,open:100,high:103,low:97,close:98}]};
  processSimulator(simulator,current(90,120000,98),stopped,{now:120001});
  assert.equal(simulator.trades.length,1); assert.equal(simulator.trades[0].causalEvidence.version,1);
  const migrated=migrateSimulator(JSON.parse(JSON.stringify(simulator)),130000);
  assert.equal(migrated.trades[0].evidenceAvailability,"consistent-causal-evidence-v1");
  assert.deepEqual(migrated.trades[0].candidateIds,simulator.trades[0].candidateIds);
  assert.deepEqual(migrated.weights,simulator.weights);
});

test("a broken causal record is rejected without poisoning later valid records", () => {
  const chronological=[];
  for(let i=1;i<=3;i+=1){
    const before=weightsFromTradeMemory(chronological.slice().reverse());
    const trade={side:"long",entry:100,exitTime:i,net:.01,pnl:1,parts:{...parts},candidateIds:["ema-alignment"]};
    chronological.push(trade);
    trade.causalEvidence={version:1,parts:{...parts},candidateIds:["ema-alignment"],weightsBefore:before,expectedWeightsAfter:weightsFromTradeMemory(chronological.slice().reverse())};
  }
  chronological[1].causalEvidence.expectedWeightsAfter.rsi=999;
  const migrated=migrateSimulator({bank:1000,weights:{rsi:15,macd:22,volume:13,bands:15,emaTrend:20,ema50:15},trades:chronological.slice().reverse()});
  assert.equal(migrated.trades.find(t=>t.exitTime===2).evidenceAvailability,"unavailable-after-migration");
  assert.equal(migrated.trades.find(t=>t.exitTime===3).evidenceAvailability,"consistent-causal-evidence-v1");
});

test("self-consistent forged local chain is labeled consistency-only, never authentic", () => {
  const forgedParts={...parts,rsi:1};
  const trade={side:"long",entry:100,exitTime:1,net:.05,pnl:5,parts:forgedParts,candidateIds:["ema-alignment"]};
  trade.causalEvidence={version:1,parts:forgedParts,candidateIds:["ema-alignment"],weightsBefore:weightsFromTradeMemory([]),expectedWeightsAfter:weightsFromTradeMemory([trade])};
  const migrated=migrateSimulator({bank:1000,weights:weightsFromTradeMemory([trade]),trades:[trade]});
  assert.equal(migrated.trades[0].evidenceAvailability,"consistent-causal-evidence-v1");
  const report=buildInstitutionalReport({simulator:migrated});
  assert.match(report.replace(/[│\n]/g," "),/authenticity requires a trusted\s+backend/i);
  assert.doesNotMatch(`${migrated.trades[0].evidenceAvailability}\n${report}`,/verified|tamper-proof/i);
});

test("two-horizon weights prioritize recent losses and loss response exceeds one win", () => {
  const make=net=>({side:"long",net,parts:{...parts,rsi:1}});
  const base=weightsFromTradeMemory([]).rsi;
  const win=Math.abs(weightsFromTradeMemory([make(.01)]).rsi-base);
  const loss=Math.abs(weightsFromTradeMemory([make(-.01)]).rsi-base);
  assert.ok(loss>win);
  const contradictory=[...Array.from({length:100},()=>make(-.02)),...Array.from({length:900},()=>make(.02))];
  assert.ok(weightsFromTradeMemory(contradictory).rsi<base);
});

test("thousand-trade migration remains synchronous and bounded", () => {
  const trades=Array.from({length:1000},(_,i)=>({side:"long",entry:100,exitTime:1000-i,net:i%2?.01:-.01,pnl:1,parts}));
  const start=performance.now(); migrateSimulator({bank:1000,weights:{rsi:15,macd:22,volume:13,bands:15,emaTrend:20,ema50:15},trades});
  assert.ok(performance.now()-start<1000);
});

test("server-shaped updatedAt becomes availableFrom: same prior candle denied, next exact candle allowed", () => {
  const payload={score:90,updatedAt:90000,source:"Investing.com",stale:false};
  const snapshot={...payload,availableFrom:payload.updatedAt};
  const prior=createSimulator(); processSimulator(prior,current(70,60000),rows(60000),{now:90001,macroSnapshot:snapshot}); assert.equal(prior.position,null);
  const next=createSimulator(); processSimulator(next,current(70,120000),rows(120000),{now:120001,macroSnapshot:snapshot}); assert.ok(next.position);
  snapshot.calculatedAt=119999; processSimulator(next,current(70,180000),rows(180000),{now:180001,macroSnapshot:snapshot}); assert.equal(snapshot.availableFrom,90000);
});

test("closed 1m evaluation is exact-once and an open candle is rejected", () => {
  const simulator=createSimulator();
  const open=processSimulator(simulator,current(90,120000),rows(120000),{now:120000}); assert.equal(open.duplicateOrOpen,true); assert.equal(simulator.position,null);
  processSimulator(simulator,current(90,120000),rows(120000),{now:120001}); const snapshotCount=simulator.decisionSnapshots.length;
  const duplicate=processSimulator(simulator,current(90,120000),rows(120000),{now:120002}); assert.equal(duplicate.duplicateOrOpen,true); assert.equal(simulator.decisionSnapshots.length,snapshotCount);
});

test("20% capital circuit closes exposure, blocks exposure and migration ignores forged clear state", () => {
  const simulator=createSimulator(); processSimulator(simulator,current(90,60000),rows(60000),{now:60001});
  simulator.bank=790; const result=processSimulator(simulator,current(90,120000,100),rows(120000),{now:120001});
  assert.equal(result.riskHalt,true); assert.equal(simulator.position,null); assert.equal(simulator.riskControl.halted,true); assert.equal(simulator.pendingReversal,null);
  processSimulator(simulator,current(90,180000),rows(180000),{now:180001}); assert.equal(simulator.position,null);
  const migrated=migrateSimulator({...simulator,riskControl:{halted:false,threshold:0}} ,200000); assert.equal(migrated.riskControl.halted,true); assert.equal(migrated.riskControl.threshold,800);
  const reset=createSimulator(); assert.equal(reset.riskControl.halted,false); assert.equal(reset.bank,1000);
});

test("final realization that breaches threshold latches before same-candle reversal", () => {
  const simulator=createSimulator(); processSimulator(simulator,current(90,60000),rows(60000),{now:60001}); simulator.bank=810;
  const stop={time:60001,closeTime:120000,open:100,high:103,low:97,close:98};
  processSimulator(simulator,current(10,120000,98),{"1m":[stop]},{now:120001});
  assert.equal(simulator.riskControl.halted,true); assert.equal(simulator.pendingReversal,null); assert.equal(simulator.position,null);
});

test("report UI uses safe textContent and responsive page overflow contract", async () => {
  const [app,css,html]=await Promise.all([readFile(new URL("../app.js",import.meta.url),"utf8"),readFile(new URL("../styles.css",import.meta.url),"utf8"),readFile(new URL("../index.html",import.meta.url),"utf8")]);
  assert.match(app,/report\.textContent\s*=\s*buildInstitutionalReport/); assert.doesNotMatch(app,/institutionalReport[^\n]*innerHTML/);
  assert.match(css,/html,body\{max-width:100%;overflow-x:hidden\}/); assert.match(css,/\.institutional-report\{[^}]*white-space:pre-wrap/); assert.match(css,/@media\(max-width:620px\)[^{]*\{\.institutional-report-card/);
  assert.match(html,/<pre id="institutionalReport"/); assert.match(html,/Reiniciar banca, memoria y bloqueo/);
});

