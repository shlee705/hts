// Each quote's own price selects its band. At a boundary the bid below
// it and the ask above it can be different distances away.
export function tickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

export function floorTick(price) {
  const unit = tickSize(price);
  return Math.floor(price / unit) * unit;
}

export function ceilTick(price) {
  const unit = tickSize(price);
  return Math.ceil(price / unit) * unit;
}

export function roundTick(price) {
  const unit = tickSize(price);
  return Math.round(price / unit) * unit;
}

export const nextTick = price => ceilTick(Math.floor(price) + 1);
export const previousTick = price => floorTick(Math.ceil(price) - 1);

export function dailyLimits(previousClose) {
  return {
    lowerLimit: ceilTick(previousClose * 70 / 100),
    upperLimit: floorTick(previousClose * 130 / 100),
  };
}
