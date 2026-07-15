import test from "node:test";
import assert from "node:assert/strict";
import { calculateDirectionalContext, FOUR_HOURS, parseAlpacaBars, POST_CLOSE_DELAY } from "../market-context.js";

function kline(index, close, volume = 100) {
  const openTime=index*FOUR_HOURS,closeTime=openTime+FOUR_HOURS-1;
  return [openTime,String(close-1),String(close+1),String(close-2),String(close),String(volume),closeTime];
}

test("directional context uses only rows available when observed",()=>{
  const rows=Array.from({length:10},(_,i)=>kline(i,100+i));
  rows.push(kline(10,50,1000));
  const observedAt=rows[9][6];
  const context=calculateDirectionalContext(rows,observedAt);
  assert.equal(context.direction,"bullish");
  assert.equal(context.asOf,rows[9][6]);
  assert.equal(context.observedAt,observedAt);
  assert.equal(context.expiresAt,rows[9][6]+FOUR_HOURS+POST_CLOSE_DELAY);
});

test("directional context fails closed with insufficient history",()=>{
  assert.equal(calculateDirectionalContext([kline(0,100)],FOUR_HOURS),null);
});

test("Alpaca crypto bars are parsed into completed four-hour rows",()=>{
  const bars=parseAlpacaBars({bars:{"BTC/USD":[{t:"2026-07-14T00:00:00Z",o:100,h:102,l:99,c:101,v:12}]}});
  assert.equal(bars.length,1);assert.equal(bars[0][0],Date.parse("2026-07-14T00:00:00Z"));assert.equal(bars[0][4],101);
  assert.equal(bars[0][6],bars[0][0]+FOUR_HOURS-1);
  assert.deepEqual(parseAlpacaBars({bars:{}}),[]);
});

test("late observation never extends a completed candle across another four-hour window",()=>{
  const rows=Array.from({length:10},(_,i)=>kline(i,100+i)),closeTime=rows.at(-1)[6];
  const context=calculateDirectionalContext(rows,closeTime+3*60*60*1000);
  assert.equal(context.expiresAt,closeTime+FOUR_HOURS+POST_CLOSE_DELAY);
  assert.ok(context.expiresAt-context.observedAt<=60*60*1000+POST_CLOSE_DELAY);
});
