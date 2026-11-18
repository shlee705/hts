export const MINUTE = 60000;
export const DAY = 86400000;
// 09:00 Asia/Seoul is 00:00 UTC throughout the year.
export const tradingDay = time => Math.floor(time / DAY) * DAY;
export function* missingMinutes(after, before) {
  for (let time = (Math.floor(after / MINUTE) + 1) * MINUTE;
       time < Math.floor(before / MINUTE) * MINUTE; time += MINUTE) yield time;
}
