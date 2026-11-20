export const periods = new Map([['1m', '1분'], ['3m', '3분'], ['5m', '5분'], ['30m', '30분'], ['1h', '1시간'], ['1d', '일']]);
const pendingLimit = 45000;

function appendBar(bars, bar) {
  const last = bars.at(-1);
  if (last?.[0] === bar[0]) bars[bars.length - 1] = bar;
  else if (!last || bar[0] > last[0]) {
    bars.push(bar);

  }
}

// Merge a point-in-time history response with live bars received while it was in flight.
// The timestamp guards against overwriting a newer close from that history response.
export function createCandleHistory(load, changed) {
  let active, revision = 0;
  function clear() {
    active?.controller.abort();
    active = null;
    revision++;
  }
  async function read(sub) {
    sub.loading = true;
    sub.pending = new Map();
    try {
      const history = await load(sub.code, sub.period, sub.controller.signal);
      if (active !== sub || history.code !== sub.code || history.period !== sub.period) return;
      const bars = history.bars.slice();
      for (const item of sub.pending.values()) {
        if (item.time > history.through) appendBar(bars, item.bar);
      }
      sub.bars = bars;
      sub.through = Math.max(history.through ?? 0, sub.through);
      sub.failed = false;
    } catch {
      if (active !== sub) return;
      sub.failed = true;
    } finally {
      if (active === sub) {
        sub.loading = false;
        sub.pending.clear();
        revision++; changed();
      }
    }
  }
  return {
    get revision() { return revision; },
    get view() { return active; },
    clear,
    select(code, period) {
      clear();
      active = { code, period, bars: [], through: 0, controller: new AbortController(), failed: false };
      const loaded = read(active);
      changed();
      return loaded;
    },
    update(code, barsByPeriod, time) {
      const sub = active, bar = barsByPeriod?.[sub?.period];
      if (!sub || sub.code !== code || !bar || time < sub.through) return;
      const previous = sub.bars.at(-1);
      if (!sub.loading && previous && bar[0] > previous[0]) read(sub);
      sub.through = time;
      if (sub.loading) {
        sub.pending.set(bar[0], { time, bar });
        if (sub.pending.size > pendingLimit) sub.pending.delete(sub.pending.keys().next().value);
      }
      if (previous && bar.every((value, i) => value === previous[i])) return;
      appendBar(sub.bars, bar);
      revision++; changed();
    },
    retry() { if (active && !active.loading) return read(active); },
  };
}

// History rolls forward as new bars replace the oldest entries. Store the
// first visible timestamp so inspecting the past survives an array shift.
export function createChartViewport() {
  let anchor = null;
  function read(bars, capacity) {
    const maxStart = Math.max(0, bars.length - capacity);
    if (anchor === null) return { start: maxStart, maxStart, following: true };
    const index = bars.findIndex(bar => bar[0] >= anchor);
    const start = index < 0 ? maxStart : Math.min(index, maxStart);
    return { start, maxStart, following: false };
  }
  return {
    read,
    moveTo(start, bars, capacity) {
      const maxStart = Math.max(0, bars.length - capacity);
      const position = Math.max(0, Math.min(Math.round(start), maxStart));
      anchor = position === maxStart ? null : bars[position][0];
      return { start: position, maxStart, following: anchor === null };
    },
    follow() { anchor = null; },
  };
}

const krw = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const timeOnly = new Intl.DateTimeFormat('ko-KR', { timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
const dayOnly = new Intl.DateTimeFormat('ko-KR', { timeZone:'Asia/Seoul', month:'2-digit', day:'2-digit' });
const daily = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const tickMinutes = [1,2,3,5,10,15,30,60,120,180,360,720,1440,2880,4320,10080,20160,43200];
const intervalMinutes = { '1m':1, '3m':3, '5m':5, '30m':30, '1h':60 };
const svgNS = 'http://www.w3.org/2000/svg';
function add(group, tag) {
  const el = document.createElementNS(svgNS, tag);
  group.append(el);
  return el;
}

export function createCandleRenderer(refs) {
  const slots = [];
  const ticks = Array.from({ length: 4 }, () => {
    const text = document.createElement('span');
    refs['chart-labels'].append(text);
    return { line: add(refs['chart-grid'], 'line'), text };
  });
  const timeTicks = [];
  let lastRevision, lastCapacity, lastStyle, lastStart, lastWidth;
  return function draw(view, revision, capacity, style, stock, start, minSlots = 12) {
    const maxStart = Math.max(0, (view?.bars.length ?? 0) - capacity);
    const first = Math.max(0, Math.min(start ?? maxStart, maxStart));
    const axisWidth = refs['chart-times'].clientWidth;
    if (lastWidth === axisWidth && lastRevision === revision && lastCapacity === capacity && lastStyle === style && lastStart === first) return;
    lastWidth = axisWidth; lastRevision = revision; lastCapacity = capacity; lastStyle = style; lastStart = first;
    const visible = view?.bars.slice(first, first + capacity) || [];
    const duration = (intervalMinutes[view?.period] ?? 1440) * 60000;
    const origin = visible[0]?.[0] ?? 0;
    const span = Math.max(minSlots * duration, (visible.at(-1)?.[0] ?? origin) - origin + duration);
    const timeX = time => 5 + 536 * ((time - origin) / span);
    const bars = [];
    // Aggregate dense candles inside the same time-axis pixel.
    let previousPixel;
    for (const source of visible) {
      const pixel = Math.floor(timeX(source[0]));
      if (pixel !== previousPixel) {
        bars.push(source.slice());
        previousPixel = pixel;
      } else {
        const column = bars.at(-1);
        column[2] = Math.max(column[2], source[2]);
        column[3] = Math.min(column[3], source[3]);
        column[4] = source[4];
      }
    }
    const numbers = stock.format ?? krw;
    refs['chart-empty'].hidden = bars.length > 0;
    refs['chart-content'].style.visibility = bars.length ? 'visible' : 'hidden';
    refs['chart-labels'].hidden = !bars.length;
    refs['retry-chart'].hidden = !view?.failed;
    if (!bars.length) {
      refs['chart-day-dividers'].setAttribute('d', '');
      refs['chart-empty'].textContent = view?.failed ? '차트 기록을 불러오지 못했습니다' : view?.loading ? '차트 기록을 불러오는 중' : '첫 시세를 기다리고 있습니다';
      for (const tick of timeTicks) tick.hidden = true;
      refs['chart-start'].textContent = '—'; refs['chart-finish'].textContent = '—';
      refs['chart-ohlc'].textContent = '';
      refs.chart.setAttribute('aria-label', `${stock.name} 차트 기록 대기 중`);
      return;
    }
    let low = Infinity, high = -Infinity;
    for (const [, , h, l] of bars) { low = Math.min(low, l); high = Math.max(high, h); }
    const pad = Math.max(stock.unit, (high - low) * 0.12);
    low -= pad; high += pad;
    const y = p => 7 + (high - p) / (high - low) * 151;
    const slotWidth = 536 * duration / span;
    const x = i => timeX(bars[i][0] + duration / 2);
    const width = Math.max(1, Math.min(15, slotWidth * 0.7));
    const dividers = [];
    if (view.period !== '1d') {
      const day = 86400000;
      const end = (Math.floor(visible.at(-1)[0] / duration) + 1) * duration;
      for (let marker = Math.ceil(origin / day) * day;
           marker < end && marker <= (view.through ?? Infinity); marker += day) {
        dividers.push('M' + timeX(marker) + ',7V158');
      }
    }
    refs['chart-day-dividers'].setAttribute('d', dividers.join(' '));
    for (let i = 0; i < ticks.length; i++) {
      const price = high - (high - low) * i / 3, pos = y(price);
      const {line, text} = ticks[i];
      line.setAttribute('x1', 0); line.setAttribute('x2', 545); line.setAttribute('y1', pos); line.setAttribute('y2', pos);
      text.style.top = (pos / 175 * 100) + '%';
      text.textContent = numbers.format(price);
    }
    refs['chart-bars'].style.display = style === 'bars' ? '' : 'none';
    refs['chart-close-line'].style.display = style === 'line' ? '' : 'none';
    if (style === 'line') {
      refs['chart-close-line'].setAttribute('d', bars.map((b, i) => `${i ? 'L' : 'M'}${x(i)},${y(b[4])}`).join(' ') + (bars.length === 1 ? ' l2,0' : ''));
    } else {
      for (let i = 0; i < Math.max(bars.length, slots.length); i++) {
        if (!slots[i]) {
          const g = add(refs['chart-bars'], 'g');
          slots.push({ g, wick: add(g, 'line'), body: add(g, 'rect') });
        }
        const {g, wick, body} = slots[i], bar = bars[i];
        g.style.display = bar ? '' : 'none';
        if (!bar) continue;
        const [, open, h, l, close] = bar, cx = x(i);
        g.setAttribute('class', close > open ? 'up' : close < open ? 'down' : 'neutral');
        wick.setAttribute('x1', cx); wick.setAttribute('x2', cx); wick.setAttribute('y1', y(h)); wick.setAttribute('y2', y(l));
        body.setAttribute('x', cx - width / 2); body.setAttribute('width', width);
        body.setAttribute('y', Math.min(y(open), y(close))); body.setAttribute('height', Math.max(1.5, Math.abs(y(open) - y(close))));
      }
    }
    const isDaily = view.period === '1d';
    const label = time => isDaily ? daily.format(time) : dayOnly.format(time) + '\n' + timeOnly.format(time);
    const last = visible.at(-1);
    refs['chart-start'].textContent = label(visible[0][0]); refs['chart-finish'].textContent = label(last[0]);
    const spacing = isDaily ? 96 : 64;
    const minStep = Math.max(duration, span * spacing * 620 / (536 * Math.max(1, axisWidth)));
    const step = (tickMinutes.find(minutes => minutes * 60000 >= minStep)
      ?? Math.ceil(minStep / 86400000) * 1440) * 60000;
    // Align intraday ticks to Seoul midnight, and daily ticks to the 09:00 trading day.
    const offset = isDaily ? 0 : 9 * 3600000;
    const firstTick = Math.ceil((origin + offset) / step) * step - offset;
    let used = 0;
    const endTime = last[0];
    const tickStart = firstTick <= last[0] ? firstTick : origin;
    for (let time = tickStart; time <= endTime; time += step) {
      const pixels = timeX(isDaily ? time + duration / 2 : time) * axisWidth / 620;
      if (!timeTicks[used]) {
        const tick = document.createElement('span');
        refs['chart-time-ticks'].append(tick);
        timeTicks.push(tick);
      }
      const tick = timeTicks[used++];
      tick.hidden = false;
      tick.style.left = (axisWidth ? pixels / axisWidth * 100 : 0) + '%';
      tick.textContent = label(time);
    }
    for (let i = used; i < timeTicks.length; i++) timeTicks[i].hidden = true;
    const ohlc = `시 ${numbers.format(last[1])}  고 ${numbers.format(last[2])}  저 ${numbers.format(last[3])}  종 ${numbers.format(last[4])}`;
    refs['chart-ohlc'].textContent = ohlc + (Number.isFinite(last[6]) ? '  거래량 ' + krw.format(last[6]) : '');
    refs.chart.setAttribute('aria-label', `${stock.name} ${periods.get(view.period)}봉. 표시 구간의 마지막 봉 ${ohlc}`);
  };
}
