export function tickSize(price) {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

export const validPrice = price => Number.isSafeInteger(price) && price > 0 && price % tickSize(price) === 0;
export const floorPrice = price => Math.floor(price / tickSize(price)) * tickSize(price);
export const ceilPrice = price => Math.ceil(price / tickSize(price)) * tickSize(price);
export const roundPrice = price => Math.max(1, Math.round(price / tickSize(price)) * tickSize(price));
export const adjacentPrice = (price, direction) => direction > 0 ? price + tickSize(price) : price - tickSize(price - 1);

export function priceLimits(previousClose) {
  return { lowerLimit: ceilPrice(previousClose * 70 / 100), upperLimit: floorPrice(previousClose * 130 / 100) };
}
