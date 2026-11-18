import assert from 'node:assert/strict';
import test from 'node:test';
import { createChartNavigation } from '../public/chart-navigation.mjs';

function fixture(t) {
  let resize;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(cb) { resize = width => cb([{ contentRect: { width } }]); }
    observe() {}
  }});
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original);
    else delete globalThis.ResizeObserver;
  });
  const classes = new Set();
  const plot = Object.assign(new EventTarget(), {
    clientWidth: 620,
    classList: {
      add: key => classes.add(key), remove: key => classes.delete(key),
      toggle: (key, show) => show ? classes.add(key) : classes.delete(key),
    },
    setPointerCapture(id) { this.capture = id; },
    releasePointerCapture() { this.capture = undefined; },
    hasPointerCapture(id) { return this.capture === id; },
  });
  const all = new EventTarget(), slider = new EventTarget(), latest = new EventTarget(), zoomIn = new EventTarget(), zoomOut = new EventTarget();
  Object.defineProperty(slider, 'valueAsNumber', { get() { return Number(this.value); }});
  slider.setAttribute = (name, value) => { slider[name] = value; };
  let view, displayed;
  const render = () => { displayed = nav.window(view); return displayed; };
  const nav = createChartNavigation({
    'chart-viewport': plot, 'chart-zoom-in': zoomIn, 'chart-zoom-out': zoomOut, 'chart-pan': slider, 'chart-latest': latest, 'chart-all': all,
  }, render);
  return {
    setView(next) { view = next; return render(); }, get displayed() { return displayed; },
    resize, plot, slider, latest, zoomIn, zoomOut, all,
  };
}

function fire(target, type, init = {}) {
  const event = Object.assign(new Event(type, {cancelable: true}), init);
  target.dispatchEvent(event);
  return event;
}
const series = (code, period = '1m', length = 100) => ({
  code, period, bars: Array.from({ length }, (_, i) => [i * 60000, i, i, i, i]),
});

test('a short history can be enlarged, scrolled to its first bar and fit again', t => {
  const ui = fixture(t);
  ui.setView(series('005930', '1m', 3));
  assert.equal(ui.slider.disabled, false);
  assert.deepEqual(ui.displayed, { count: 2, start: 1 });
  assert.equal(ui.zoomIn.disabled, false);
  fire(ui.zoomIn, 'click');
  assert.deepEqual(ui.displayed, { count: 1, start: 2 });
  assert.equal(ui.slider.disabled, false);
  ui.slider.value = '0';
  fire(ui.slider, 'input');
  assert.equal(ui.displayed.start, 0);
  fire(ui.zoomOut, 'click');
  fire(ui.zoomOut, 'click');
  assert.equal(ui.slider.disabled, true);
});

test('slider remembers separate stock, index and period positions, including pending history and resize', t => {
  const ui = fixture(t);
  const stock = series('005930'), index = series('PULSE100');
  assert.deepEqual(ui.setView(stock), { count: 32, start: 68 });
  assert.equal(ui.slider.disabled, false);
  ui.slider.value = '9';
  fire(ui.slider, 'input');
  assert.equal(ui.displayed.start, 9);
  assert.equal(ui.latest.disabled, false);
  assert.deepEqual(ui.setView(index), { count: 32, start: 68 });
  ui.slider.value = '4';
  fire(ui.slider, 'input');
  ui.setView(series('005930', '1m', 0));
  assert.equal(ui.slider.disabled, true);
  assert.equal(ui.setView(stock).start, 9);
  assert.equal(ui.setView(index).start, 4);
  assert.equal(ui.setView(series('PULSE100', '3m')).start, 68);
  ui.setView(index);
  ui.resize(240);
  assert.deepEqual(ui.displayed, { count: 13, start: 4 });
  fire(ui.latest, 'click');
  assert.equal(ui.displayed.start, 87);
  assert.equal(ui.latest.disabled, true);
});

test('vertical wheel zooms stock and index even when all recorded bars fit', t => {
  const ui = fixture(t);
  for (const code of ['005930', 'PULSE100']) {
    ui.setView(series(code, '1m', 3));
    const wheel = {deltaX:0, deltaY:100, deltaMode:0};
    fire(ui.plot, 'wheel', wheel);
    assert.equal(ui.displayed.count, 3);
    assert.equal(ui.slider.disabled, true);
    assert.equal(fire(ui.plot, 'wheel', {...wheel, deltaY:-100}).defaultPrevented, true);
    assert.equal(ui.displayed.count, 1);
    assert.equal(ui.slider.disabled, false);
    fire(ui.plot, 'wheel', wheel);
    assert.equal(ui.displayed.count, 2);
  }
});

test('drag and horizontal wheel pan the chart and Ctrl+wheel preserves browser zoom', t => {
  const ui = fixture(t), stock = series('005930');
  ui.setView(stock);
  const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 50 };
  fire(ui.plot, 'pointerdown', pointer);
  fire(ui.plot, 'pointermove', { ...pointer, clientX: 134, clientY: 130 });
  assert.equal(ui.displayed.start, 68);
  fire(ui.plot, 'pointermove', { ...pointer, clientX: 134 });
  assert.equal(ui.displayed.start, 66);
  fire(ui.plot, 'pointercancel', pointer);
  assert.equal(ui.plot.capture, undefined);
  fire(ui.plot, 'pointermove', { ...pointer, clientX: 250 });
  assert.equal(ui.displayed.start, 66);
  const wheel = { deltaX: 0, deltaY: 34, deltaMode: 0, shiftKey: false, ctrlKey: false };
  assert.equal(fire(ui.plot, 'wheel', { ...wheel, ctrlKey: true, deltaX: 50 }).defaultPrevented, false);
  assert.equal(ui.displayed.start, 66);
  assert.equal(fire(ui.plot, 'wheel', { ...wheel, deltaX: -50 }).defaultPrevented, true);
  assert.equal(ui.displayed.start, 64);
  fire(ui.plot, 'wheel', { ...wheel, shiftKey: true });
  assert.equal(ui.displayed.start, 66);
  fire(ui.plot, 'pointerdown', { ...pointer, pointerType: 'mouse' });
  ui.setView(series('PULSE100'));
  assert.equal(ui.plot.capture, undefined);
  fire(ui.plot, 'pointermove', { ...pointer, clientX: 250 });
  assert.equal(ui.displayed.start, 68);
});
test('full history includes the oldest minute and follows new minutes for stocks and index', t => {
  const ui = fixture(t);
  for (const code of ['005930', 'KPI100']) {
    const view = series(code,'1m',45001);
    ui.setView(view);
    fire(ui.all,'click');
    assert.deepEqual(ui.displayed,{count:45001,start:0});
    view.bars.push([45001*60000,10,10,10,10]);
    ui.setView(view);
    assert.deepEqual(ui.displayed,{count:45002,start:0});
    fire(ui.latest,'click');
    assert.ok(ui.displayed.start > 44900);
  }
});
