const finite = value => Number.isFinite(value);

function formatMoney(value) {
  if (!finite(value)) return "--";
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} US$`;
}

function formatPercent(value, digits = 1) {
  return finite(value) ? `${value.toFixed(digits)}%` : "--";
}

function pad(label, value) {
  return `${label.padEnd(18, " ")} ${value}`;
}

function structuralFill(position, plan) {
  const expectedReason = `Structural partial: ${plan.reason}`;
  return (position.partials || []).find(partial => partial.reason === expectedReason
    && (!finite(plan.executedAt) || partial.time === plan.executedAt));
}

function riskPresentation(position, markPrice, equity) {
  const floor = position.effectiveFloor;
  const budget = position.baselineEquity - floor;
  const available = finite(position.baselineEquity) && position.baselineEquity > 0 && finite(floor) && finite(equity) && equity > 0 && budget > 0;
  const used = available ? Math.min(100, Math.max(0, position.baselineEquity - equity) / budget * 100) : null;
  const remaining = available ? Math.max(0, equity - floor) : null;
  const directionalDistance = finite(markPrice) && markPrice > 0 && finite(position.riskBoundary)
    ? (position.side === "short" ? position.riskBoundary - markPrice : markPrice - position.riskBoundary) / markPrice * 100
    : null;
  const tone = !available ? "unknown" : used >= 90 ? "critical" : used >= 70 ? "warning" : "normal";
  return { used, remaining, directionalDistance, tone, available };
}

export function buildActiveTradePanel(position, { markPrice, equity } = {}) {
  if (!position) {
    return {
      tone: "idle",
      text: [
        "+------------------------------------------+",
        "|          SIN OPERACION ACTIVA             |",
        "+------------------------------------------+",
        "| Esperando una entrada confirmada.         |",
        "+------------------------------------------+"
      ].join("\n")
    };
  }

  const remainingFraction = finite(position.remainingFraction) ? Math.min(1, Math.max(0, position.remainingFraction)) : null;
  const closedFraction = finite(remainingFraction) ? 1 - remainingFraction : null;
  const plans = (position.structuralPartials || []).slice(0, 2);
  const risk = riskPresentation(position, markPrice, equity);
  const lines = [
    "+--------------------------------------------------------+",
    `| OPERACION ACTIVA: ${String(position.side || "--").toUpperCase().padEnd(35, " ")}|`,
    "+--------------------------------------------------------+",
    pad("ENTRY PROMEDIO", formatMoney(position.weightedAverage))
  ];

  for (let index = 0; index < 2; index++) {
    const plan = plans[index];
    if (!plan) {
      lines.push(pad(`TP PARCIAL ${index + 1}`, "SIN NIVEL ESTRUCTURAL"));
      continue;
    }
    const fill = structuralFill(position, plan);
    const filled = Boolean(plan.executed);
    const price = filled ? (fill ? fill.fillPrice ?? fill.price : null) : plan.level;
    const cumulative = filled && fill && finite(position.totalNotional) && position.totalNotional > 0
      ? (position.partials || []).filter(partial => partial.sequence <= fill.sequence).reduce((sum, partial) => sum + (finite(partial.notional) ? partial.notional : 0), 0) / position.totalNotional
      : null;
    const filledClosed = finite(cumulative) ? formatPercent(cumulative * 100) : "SIN DATO";
    const status = filled ? `FILLED ${formatMoney(price)} | CERRADO ${filledClosed}` : `PENDING ${formatMoney(price)}`;
    lines.push(pad(`TP PARCIAL ${index + 1}`, status));
    lines.push(pad("  MOTIVO", String(plan.reason || "Sin motivo registrado")));
  }

  lines.push(pad("TP TOTAL", `DYNAMIC RUNNER | CERRADO ${finite(closedFraction) ? formatPercent(closedFraction * 100) : "NO DISPONIBLE"} | RESTA ${finite(remainingFraction) ? formatPercent(remainingFraction * 100) : "NO DISPONIBLE"}`));
  lines.push(pad("SL HARD -10%", formatMoney(position.riskBoundary)));
  lines.push(pad("  DISTANCIA", `${finite(risk.directionalDistance) ? formatPercent(risk.directionalDistance) : "NO DISPONIBLE"} PRECIO | ${finite(risk.remaining) ? formatMoney(risk.remaining) : "NO DISPONIBLE"} HASTA FLOOR`));
  lines.push(pad("  USO DE RIESGO", risk.available ? `${formatPercent(risk.used, 0)} DEL LIMITE (AVISO VISUAL)` : "NO DISPONIBLE"));
  lines.push("+--------------------------------------------------------+");

  return { tone: risk.tone, text: lines.join("\n") };
}
