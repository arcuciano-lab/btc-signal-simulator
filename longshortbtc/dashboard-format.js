const localizedNumber = (value, digits, locale = "es-ES") => new Intl.NumberFormat(locale, {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits
}).format(value);

export function formatVolumeRatio(value, locale = "es-ES") {
  return Number.isFinite(value) && value >= 0
    ? `${localizedNumber(value, 2, locale)}\u00D7`
    : "\u2014";
}

export function getVolumeConfirmationLabel(value) {
  return Number.isFinite(value) && value >= 1.1
    ? "Volumen confirma"
    : "Confirmaci\u00f3n d\u00e9bil";
}

export function formatWinRate(closedWins, closedTrades, locale = "es-ES") {
  const validCounts = Number.isInteger(closedWins)
    && Number.isInteger(closedTrades)
    && closedTrades >= 0
    && closedWins >= 0
    && closedWins <= closedTrades;
  if (!validCounts || closedTrades === 0) {
    return "\u2014";
  }

  return `${localizedNumber(closedWins / closedTrades * 100, 1, locale)}%`;
}
