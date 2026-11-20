import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandleHistory, createCandleRenderer, createChartViewport } from '../public/candle-chart.mjs';

const bar = (start, price) => [start, price, price, price, price];
test('a new chart selection discards late history and merges only ticks newer than the fetched snapshot', async () => {
  const requests = [];
  const chart = createCandleHistory((code, period, signal) => new Promise(resolve => {
    requests.push({ code, period, signal, resolve });
  }), () => {});
  const a = chart.select('A', '1m');
  const b = chart.select('B', '3m');
  const current = chart.select('A', '1m');
  assert.ok(requests[0].signal.aborted && requests[1].signal.aborted);
  requests[0].resolve({ code: 'A', period: '1m', through: 0, bars: [bar(0, 10)] });
  requests[1].resolve({ code: 'B', period: '3m', through: 0, bars: [bar(0, 90)] });
  await Promise.all([a, b]);
  chart.update('A', { '1m': bar(0, 12) }, 50000);
  chart.update('A', { '1m': bar(60000, 15) }, 61000);
  requests[2].resolve({ code: 'A', period: '1m', through: 57000, bars: [bar(0, 13)] });
  await current;
  assert.deepEqual(chart.view.bars, [bar(0, 13), bar(60000, 15)]);
  chart.update('A', { '1m': bar(60000, 14) }, 60001);
  assert.equal(chart.view.bars.at(-1)[4], 15);
  chart.clear(); assert.equal(chart.view, null);
});

test('bar rollover restores a final recorded close missing from the live stream', async () => {
  const history = [
    { through: 1000, bars: [bar(0, 10)] },
    { through: 61000, bars: [[0, 10, 14, 9, 13], bar(60000, 15)] },
  ];
  const chart = createCandleHistory(async () => ({ code: 'A', period: '1m', ...history.shift() }), () => {});
  await chart.select('A', '1m');
  chart.update('A', { '1m': bar(60000, 15) }, 61000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(chart.view.bars[0], [0, 10, 14, 9, 13]);
});

test('a pending history response retains the first live bar after a restart in the same minute', async () => {
  let respond;
  const chart = createCandleHistory(() => new Promise(resolve => { respond = resolve; }), () => {});
  const load = chart.select('KPI10', '1m');
  const before = [...bar(60000, 1900), 50000];
  const after = [...bar(76000, 1910), 76000];
  chart.update('KPI10', { '1m': after }, 77500);
  respond({ code: 'KPI10', period: '1m', through: 74000, bars: [before] });
  await load;
  chart.update('KPI10', { '1m': [76000, 1910, 1920, 1910, 1920, 76000] }, 78000);
  assert.deepEqual(chart.view.bars, [before, [76000, 1910, 1920, 1910, 1920, 76000]]);
});

test('panning pins the first visible timestamp through updates, rollover, reload and resize', () => {
  const viewport = createChartViewport();
  let bars = Array.from({ length: 6 }, (_, i) => bar(i * 60000, 100 + i));
  assert.deepEqual(viewport.read(bars, 3), { start: 3, maxStart: 3, following: true });
  assert.deepEqual(viewport.moveTo(2, bars, 3), { start: 2, maxStart: 3, following: false });
  const anchor = bars[2][0];
  bars = [...bars.slice(1), bar(360000, 106)];
  bars[5] = bar(360000, 108);
  assert.deepEqual(viewport.read(bars, 3), { start: 1, maxStart: 3, following: false });
  assert.equal(bars[viewport.read(bars, 4).start][0], anchor);
  assert.deepEqual(viewport.read([], 3), { start: 0, maxStart: 0, following: false });
  assert.equal(bars[viewport.read(bars, 3).start][0], anchor);
  assert.equal(viewport.read(bars, 6).start, 0);
  assert.equal(bars[viewport.read(bars, 2).start][0], anchor);
  bars = bars.slice(2);
  assert.deepEqual(viewport.read(bars, 2), { start: 0, maxStart: 2, following: false });
  assert.equal(viewport.moveTo(-10, bars, 2).start, 0);
  assert.deepEqual(viewport.moveTo(10, bars, 2), { start: 2, maxStart: 2, following: true });
  bars.push(bar(420000, 109));
  assert.equal(viewport.read(bars, 2).start, 3);
  viewport.moveTo(0, bars, 2);
  viewport.follow();
  assert.deepEqual(viewport.read(bars, 2), { start: 3, maxStart: 3, following: true });
});

// Exercise real SVG geometry and settings without installing a browser runtime for node:test.
function chartFixture(t) {
  const element = () => ({ style: {}, attributes: {}, children: [],
    setAttribute(key, value) { this.attributes[key] = String(value); }, append(child) { this.children.push(child); } });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: element, createElementNS: element } });
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document; });
  const refs = Object.fromEntries(['chart', 'chart-grid', 'chart-day-dividers', 'chart-labels', 'chart-empty', 'chart-content', 'retry-chart',
    'chart-start', 'chart-finish', 'chart-times', 'chart-time-ticks', 'chart-ohlc', 'chart-bars', 'chart-close-line'].map(k => [k, element()]));
  refs['chart-times'].clientWidth = 720;
  return { refs, draw: createCandleRenderer(refs) };
}

test('candles render recorded OHLC and style, and clear when switching to an empty chart', t => {
  const { refs, draw } = chartFixture(t);
  const stock = { name: '삼성전자', unit: 10 };
  const view = { period: '1m', bars: [bar(0, 1000), [60000, 1000, 1030, 990, 1020], [120000, 1020, 1030, 1000, 1010]] };
  draw(view, 1, 2, 'bars', stock);
  assert.deepEqual(refs['chart-bars'].children.map(g => g.attributes.class), ['up', 'down']);
  assert.match(refs.chart.attributes['aria-label'], /삼성전자 1분봉/);
  assert.match(refs['chart-ohlc'].textContent, /종 1,010/);
  draw(view, 1, 3, 'line', stock);
  assert.equal(refs['chart-bars'].style.display, 'none');
  assert.match(refs['chart-close-line'].attributes.d, /^M.*L.*L/);
  draw(null, 2, 3, 'line', stock);
  assert.equal(refs['chart-content'].style.visibility, 'hidden');
  assert.equal(refs['chart-ohlc'].textContent, '');

  const index = { name: 'KOSPI 10', unit: 0.01, format: new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) };
  const indexView = { period: '1d', bars: [[0, 999.97, 1000.09, 999.93, 1000.02]] };
  draw(indexView, 3, 60, 'bars', index);
  assert.match(refs.chart.attributes['aria-label'], /KOSPI 10 일봉/);
  assert.match(refs['chart-ohlc'].textContent, /시 999\.97.*고 1,000\.09.*저 999\.93.*종 1,000\.02/);
  assert.match(refs['chart-labels'].children[0].textContent, /\d\.\d{2}$/);
  assert.equal(refs['chart-bars'].children[0].attributes.class, 'up');
  draw(indexView, 3, 60, 'line', index);
  assert.equal(refs['chart-bars'].style.display, 'none');
  assert.match(refs['chart-close-line'].attributes.d, /^M.*l2,0/);
});

test('sliding updates OHLC, timestamps and session dividers for the visible candles or close line', t => {
  const { refs, draw } = chartFixture(t);
  const markerTime = Date.parse('2026-11-18T09:00:00+09:00');
  const view = { period: '1m', bars: [-2, -1, 0, 1].map(i =>
    [...bar(markerTime + i * 60000, 100 + i), i < 0 ? markerTime - 120000 : markerTime]) };
  const time = key => refs[key].textContent;
  for (const name of ['삼성전자', 'KOSPI 10']) {
    const subject = { name, unit: 1 };
    for (const style of ['bars', 'line']) {
      draw(view, 1, 2, style, subject, 2);
      assert.match(time('chart-ohlc'), /종 101$/);
      assert.match(time('chart-start'), /09:00/);
      assert.equal(refs['chart-day-dividers'].attributes.d, 'M5,7V158');
      draw(view, 1, 2, style, subject, 1);
      assert.match(refs.chart.attributes['aria-label'], /마지막 봉 .*종 100$/);
      assert.match(time('chart-start'), /08:59/);
      assert.match(time('chart-finish'), /09:00/);
      assert.match(refs['chart-day-dividers'].attributes.d, /^M/);
      draw(view, 1, 2, style, subject, 0);
      assert.match(time('chart-ohlc'), /종 99$/);
      assert.match(time('chart-finish'), /08:59/);
      assert.equal(refs['chart-day-dividers'].attributes.d, '');
    }
  }
});

test('all intraday stock and index views mark 09:00 KST each day, including weekends', t => {
  const { refs, draw } = chartFixture(t);
  const open = Date.parse('2026-11-21T09:00:00+09:00');
  const path = () => refs['chart-day-dividers'].attributes.d;
  let revision = 0;
  for (const name of ['삼성전자', 'KOSPI 10']) {
    for (const style of ['line', 'bars']) {
      for (const [period, minutes] of Object.entries({ '1m':1, '3m':3, '5m':5, '30m':30, '1h':60 })) {
        const offsets = [-minutes, 0, minutes, 1440, 1440+minutes];
        const bars = offsets.map(m => bar(open + m*60000, 100));
        const subject = { name, unit:1 };
        const span = 1440 + 3*minutes;
        const marker = m => 'M' + (5 + 536*((m+minutes)/span)) + ',7V158';
        draw({ period, bars }, ++revision, bars.length, style, subject);
        assert.equal(path(), [marker(0), marker(1440)].join(' '));
        draw({ period, bars:[bars[0]], through:open-1 }, ++revision, 1, style, subject);
        assert.equal(path(), '');
      }
      draw({ period:'1d', bars:[bar(open, 100)] }, ++revision, 1, style, {name,unit:1});
      assert.equal(path(), '');
    }
  }
});
test('time axis places intermediate KST labels from the visible bars and adapts to width', t => {
  const {refs,draw}=chartFixture(t);
  const start=Date.parse('2026-11-18T20:24:00+09:00');
  const view={period:'1m',bars:Array.from({length:90},(_,i)=>bar(start+i*60000,180000))};
  const ticks=()=>refs['chart-time-ticks'].children.filter(tick=>!tick.hidden);
  for(const style of ['line','bars']){
    refs['chart-times'].clientWidth=720;
    draw(view,1,60,style,{name:'KOSPI 10',unit:1},0);
    const labels=ticks().map(tick=>tick.textContent);
    assert.ok(labels.length>=4);
    for(const label of [refs['chart-start'].textContent,...labels,refs['chart-finish'].textContent]){
      const [date,time]=label.split('\n');
      assert.match(date,/11.*18/);
      assert.ok(time >= '20:24' && time <= '21:23');
    }
    draw(view,1,60,style,{name:'KOSPI 10',unit:1},30);
    assert.notDeepEqual(ticks().map(tick=>tick.textContent),labels);
    refs['chart-times'].clientWidth=360;
    draw(view,1,60,style,{name:'KOSPI 10',unit:1},30);
    assert.ok(ticks().length<labels.length);
  }
});
test('missing candles leave clock ticks evenly spaced across the KST date boundary', t => {
  const {refs, draw}=chartFixture(t);
  const start=Date.parse('2026-11-18T23:24:00+09:00');
  const bars=[0,1,3,9,43,55,59].map(i=>bar(start+i*60000,100));
  draw({period:'1m',bars},1,bars.length,'bars',{name:'삼성전자',unit:1});
  const ticks=refs['chart-time-ticks'].children;
  assert.deepEqual(ticks.map(t=>t.textContent.split('\n')[1]),['23:30','23:40','23:50','00:00','00:10','00:20']);
  const x=ticks.map(t=>parseFloat(t.style.left));
  for(let i=2;i<x.length;i++) assert.ok(Math.abs((x[i]-x[i-1])-(x[1]-x[0]))<1e-9);
});
test('clock ticks line up with the matching candle wicks', t=>{
  const {refs,draw}=chartFixture(t);
  const start=Date.parse('2026-11-18T20:00:00+09:00');
  const bars=Array.from({length:30},(_,i)=>bar(start+i*60000,100));
  draw({period:'1m',bars},1,30,'bars',{name:'삼성전자',unit:1});
  for(const tick of refs['chart-time-ticks'].children){
    const minute=Number(tick.textContent.slice(-2));
    const wick=refs['chart-bars'].children[minute].children[0];
    assert.ok(Math.abs(parseFloat(tick.style.left)*6.2-Number(wick.attributes.x1))<1e-8);
  }
});
