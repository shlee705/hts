import { createChartViewport } from './candle-chart.mjs';

const plotFraction = 536 / 620; // Width of the candle slots within the SVG viewBox.
const capacityFor = width => Math.max(12, Math.min(32, Math.floor(width * plotFraction / 15)));
const positionTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function createChartNavigation(refs, changed) {
  const plot = refs['chart-viewport'];
  const zoomIn = refs['chart-zoom-in'], zoomOut = refs['chart-zoom-out'];
  const slider = refs['chart-pan'], latest = refs['chart-latest'];
  const positions = new Map();
  const all = refs['chart-all'];
  let requestedCapacity, showAll = false;
  let width = plot.clientWidth, capacity = capacityFor(width);
  let view, position, drag, wheelRemainder = 0, wheelAction, lastWheelTime = -Infinity, labelKey;

  function endDrag() {
    if (!drag) return;
    const { id } = drag;
    drag = undefined;
    plot.classList.remove('is-panning');
    if (plot.hasPointerCapture(id)) plot.releasePointerCapture(id);
  }

  function slide(start) {
    if (!position || !view?.bars.length) return;
    const current = position.read(view.bars, capacity);
    const next = Math.max(0, Math.min(current.maxStart, start));
    if (next === current.start && (next !== current.maxStart || current.following)) return;
    position.moveTo(next, view.bars, capacity);
    changed();
  }

  function pixelsPerBar() {
    return width * plotFraction / Math.max(Math.min(12, capacity), Math.min(view.bars.length, capacity));
  }

  function zoom(factor) {
    if (!view?.bars.length) return;
    endDrag();
    showAll = false;
    const visible = Math.min(capacity, view.bars.length);
    requestedCapacity = Math.max(1, Math.min(view.bars.length, factor < 1 ? Math.floor(visible * factor) : Math.ceil(visible * factor)));
    capacity = requestedCapacity;
    changed();
  }
  zoomIn.addEventListener('click', () => zoom(0.65));
  zoomOut.addEventListener('click', () => zoom(1.6));
  slider.addEventListener('input', () => slide(slider.valueAsNumber));
  all.addEventListener('click', () => {
    showAll = true;
    endDrag();
    position?.follow();
    changed();
  });
  latest.addEventListener('click', () => {
    if (showAll) requestedCapacity = undefined;
    showAll = false;
    position?.follow();
    changed();
  });

  plot.addEventListener('pointerdown', event => {
    if (slider.disabled || !event.isPrimary || event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, started: false, remainder: 0 };
    plot.setPointerCapture(event.pointerId);
  });
  plot.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    const delta = drag.x - event.clientX;
    if (!drag.started) {
      if (Math.abs(delta) < 3) return;
      if (event.pointerType === 'touch' && Math.abs(delta) < Math.abs(drag.y - event.clientY)) return;
      drag.started = true;
      plot.classList.add('is-panning');
    }
    drag.x = event.clientX;
    const pixels = drag.remainder + delta, step = pixelsPerBar();
    const bars = Math.trunc(pixels / step);
    drag.remainder = pixels - bars * step;
    if (bars) slide(position.read(view.bars, capacity).start + bars);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    plot.addEventListener(type, event => { if (event.pointerId === drag?.id) endDrag(); });
  }
  plot.addEventListener('wheel', event => {
    if (event.ctrlKey || !view?.bars.length) return;
    const horizontal = Math.abs(event.deltaX) >= Math.abs(event.deltaY);
    const action = horizontal || event.shiftKey ? 'pan' : 'zoom';
    if (action === 'pan' && slider.disabled) return;
    const delta = horizontal ? event.deltaX : event.deltaY;
    if (!delta) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
    if (action !== wheelAction || event.timeStamp - lastWheelTime > 250 || wheelRemainder * delta < 0) wheelRemainder = 0;
    wheelAction = action;
    lastWheelTime = event.timeStamp;
    wheelRemainder += delta * unit;
    event.preventDefault();
    if (action === 'zoom') {
      if (event.deltaMode || Math.abs(wheelRemainder) >= 32) {
        wheelRemainder = 0;
        if (!(delta < 0 ? zoomIn : zoomOut).disabled) zoom(delta < 0 ? 0.65 : 1.6);
      }
      return;
    }
    const step = pixelsPerBar();
    const bars = Math.trunc(wheelRemainder / step);
    wheelRemainder -= bars * step;
    if (bars) slide(position.read(view.bars, capacity).start + bars);
  }, { passive: false });

  new ResizeObserver(([entry]) => {
    if (!entry.contentRect.width) return;
    if (width === entry.contentRect.width) return;
    width = entry.contentRect.width;
    const next = requestedCapacity ?? capacityFor(width);
    endDrag();
    capacity = next;
    changed();
  }).observe(plot);

  return {
    window(nextView) {
      if (nextView !== view) {
        endDrag();
        wheelRemainder = 0;
        view = nextView;
        if (view) {
          const key = view.code + '/' + view.period;
          if (!positions.has(key)) positions.set(key, createChartViewport());
          position = positions.get(key);
        } else {
          position = undefined;
        }
      }
      const total = view?.bars.length ?? 0;
      // Leave some earlier history within reach even on a freshly started market.
      all.disabled = total === 0 || showAll;
      capacity = showAll ? Math.max(total, 1) : requestedCapacity ?? Math.min(capacityFor(width), Math.max(1, Math.floor(total * 0.8)));
      const { start, maxStart, following } = position?.read(view.bars, capacity)
        ?? { start: 0, maxStart: 0, following: true };
      const canPan = maxStart > 0;
      if (!canPan) endDrag();
      slider.disabled = !canPan;
      slider.title = canPan ? '좌우로 이동' : '전체 기록이 표시되어 있습니다';
      zoomIn.disabled = Math.min(capacity, view?.bars.length ?? 0) <= 1;
      zoomOut.disabled = !canPan;
      plot.classList.toggle('can-pan', canPan);
      if (slider.max !== String(maxStart)) slider.max = String(maxStart);
      if (slider.valueAsNumber !== start) slider.value = String(start);
      latest.disabled = following && !showAll;
      const timestamp = view?.bars[start]?.[0];
      const key = following ? 'latest' : timestamp;
      if (key !== labelKey) {
        labelKey = key;
        slider.setAttribute('aria-valuetext', following ? '최신 구간' :
          timestamp === undefined ? '기록 대기 중' : positionTime.format(timestamp) + '부터');
      }
      return { count: capacity, start };
    },
  };
}
