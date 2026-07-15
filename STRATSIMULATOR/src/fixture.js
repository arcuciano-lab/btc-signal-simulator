export const syntheticBtcCandles = Object.freeze([
  [1, 100, 102, 99, 101, 10], [2, 101, 104, 100, 103, 12],
  [3, 103, 107, 102, 106, 14], [4, 106, 109, 105, 108, 13],
  [5, 108, 109, 103, 104, 18], [6, 104, 105, 99, 100, 20],
  [7, 100, 103, 98, 102, 15]
].map(([time, open, high, low, close, volume]) =>
  Object.freeze({ time, open, high, low, close, volume })));
