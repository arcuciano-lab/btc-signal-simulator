const UNIT_MULTIPLIERS = { "":1, "%":1, k:1e3, m:1e6, b:1e9, t:1e12 };
export function parseComparableMacroValue(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const compact = String(value).trim().replace(/\s+/g, "");
  if ((compact.match(/,/g) || []).length > 1 || (compact.includes(",") && compact.includes("."))) return null;
  const normalized = compact.includes(",") ? compact.replace(",", ".") : compact;
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(%|[KMBT])?$/i);
  if (!match) return null;
  const unit = (match[2] || "").toLowerCase(), number = Number(match[1]);
  return Number.isFinite(number) ? { value:number * UNIT_MULTIPLIERS[unit], unit:unit === "%" ? "%" : "number" } : null;
}
function proximityPoints(timestamp, now) { if (!Number.isFinite(timestamp)) return 0; const minutes=(timestamp-now)/60000; if(minutes>=-60&&minutes<=30)return 30;if(minutes>30&&minutes<=120)return 22;if(minutes>120&&minutes<=360)return 14;if(minutes>360&&minutes<=1440)return 6;return 0; }
function importancePoints(impact) { return ({ high:55, medium:36, low:20 })[String(impact || "").toLowerCase()] || 0; }
export function scoreMacroEvent(event, now = Date.now()) {
  const importance=importancePoints(event?.impact), proximity=proximityPoints(Number(event?.timestamp),now), actual=parseComparableMacroValue(event?.actual), forecast=parseComparableMacroValue(event?.forecast); let surprise=0;
  if(actual&&forecast&&actual.unit===forecast.unit){const scale=Math.max(Math.abs(forecast.value),Math.abs(actual.value),actual.unit==="%"?0.1:1);surprise=Math.min(15,Math.round(Math.abs(actual.value-forecast.value)/scale*30));}
  return {score:Math.min(100,importance+proximity+surprise),importance,proximity,surprise};
}
export function classifyMacroEventScore(score) {
  const bounded = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  if (bounded >= 65) return { band:"high", label:"ALTO" };
  if (bounded >= 40) return { band:"medium", label:"MEDIO" };
  return { band:"low", label:"BAJO" };
}
export function calculateMacroImpact(events, now = Date.now()) {
  const unique = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const title = String(event?.title || "").trim().toLocaleLowerCase("es").replace(/\s+/g, " ");
    const key = event?.id != null ? `id:${event.id}` : `${Number(event?.timestamp)}\u0000${String(event?.currency || "").toUpperCase()}\u0000${title}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  const scored=[...unique.values()].map(event=>scoreMacroEvent(event,now)).sort((a,b)=>b.score-a.score); const score=Math.min(100,Math.round((scored[0]?.score||0)+(scored[1]?.score||0)*.2+(scored[2]?.score||0)*.1)); const band=score>=85?"extreme":score>=65?"high":score>=40?"moderate":"low"; const lead=scored[0]||{importance:0,proximity:0,surprise:0};
  return {score,band,label:{low:"BAJO",moderate:"MODERADO",high:"ALTO",extreme:"EXTREMO"}[band],explanation:`Intensidad ${score}/100: importancia ${lead.importance}, proximidad ${lead.proximity}, sorpresa comparable ${lead.surprise}. No indica dirección del mercado.`};
}
