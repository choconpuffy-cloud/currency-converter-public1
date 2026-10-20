import { evaluate } from './calc.js';
import { COUNTRY_TO_CURRENCY, flagFor, nameFor } from './currencies.js';
import { TZ_TO_COUNTRY } from './tz-map.js';

const RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const REFRESH_AFTER_MS = 6 * 3600e3;
const STALE_AFTER_MS = 3 * 86400e3;
const GPS_TTL_MS = 12 * 3600e3;
const DEFAULT_SAVED = ['VND', 'USD'];
const APP_VERSION = 10; // shown in Edit mode; bump with the CACHE name in sw.js

// ---------- storage (best effort: private mode can throw) ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// ---------- screen height ----------
// iOS home-screen apps with a see-through status bar report a viewport that is short by
// the status bar's height, leaving a strip under the keypad. There the app always fills
// the screen, so use the real screen height instead.
function fixAppHeight() {
  if (!navigator.standalone) return;
  const landscape = matchMedia('(orientation: landscape)').matches;
  const h = landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
  document.documentElement.style.setProperty('--app-h', `${Math.max(h, innerHeight)}px`);
}
fixAppHeight();
addEventListener('resize', fixAppHeight);

// ---------- state ----------
const state = {
  saved: store.get('cc.saved', DEFAULT_SAVED), // persists until you remove it
  local: null, // auto-detected from location; never persisted, so it drops off when you leave
  localSource: '',
  rates: store.get('cc.rates', null), // { rates: {CODE: perUSD}, updated: ms }
  active: store.get('cc.active', DEFAULT_SAVED[0]),
  expr: '',
  editing: false,
  layout: store.get('cc.layout', 'list'), // 'list' or 'bubbles'
};

// ---------- location ----------
function detectLocalCurrency() {
  const gps = store.get('cc.gps', null);
  if (gps && Date.now() - gps.at < GPS_TTL_MS && COUNTRY_TO_CURRENCY[gps.country]) {
    state.local = COUNTRY_TO_CURRENCY[gps.country];
    state.localSource = 'GPS';
    return;
  }
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {}
  const country = TZ_TO_COUNTRY[tz];
  state.local = COUNTRY_TO_CURRENCY[country] ?? null;
  state.localSource = state.local ? 'time zone' : '';
}

function locateWithGps() {
  if (!navigator.geolocation) return alert('Location is not available on this device.');
  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      try {
        const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${coords.latitude}&longitude=${coords.longitude}&localityLanguage=en`;
        const { countryCode } = await (await fetch(url)).json();
        if (!COUNTRY_TO_CURRENCY[countryCode]) throw new Error('unknown country');
        store.set('cc.gps', { country: countryCode, at: Date.now() });
        detectLocalCurrency();
        closePicker();
        render();
      } catch {
        alert('Could not look up your country. Check your connection and try again.');
      }
    },
    () => alert('Location permission denied. The app will keep using your time zone.'),
    { timeout: 15000, maximumAge: 600000 },
  );
}

// ---------- rates ----------
async function refreshRates(force = false) {
  if (!force && state.rates && Date.now() - state.rates.updated < REFRESH_AFTER_MS) return;
  setStatus('Updating rates…');
  try {
    const res = await fetch(RATES_URL, { cache: 'no-store' });
    const data = await res.json();
    if (data.result !== 'success') throw new Error(data['error-type'] || 'bad response');
    state.rates = { rates: data.rates, updated: data.time_last_update_unix * 1000 };
    store.set('cc.rates', state.rates);
  } catch {
    // Keep using cached rates offline.
  }
  render();
}

function convert(amount, from, to) {
  const r = state.rates?.rates;
  if (!r || !r[from] || !r[to]) return NaN;
  return (amount / r[from]) * r[to];
}

// ---------- formatting ----------
const digitsCache = {};
function fractionDigits(code) {
  if (!(code in digitsCache)) {
    try {
      digitsCache[code] = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits;
    } catch {
      digitsCache[code] = 2;
    }
  }
  return digitsCache[code];
}

function format(value, code) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en', {
    minimumFractionDigits: 0,
    // Small amounts get extra precision; from 100,000 up, cents are just noise.
    maximumFractionDigits: Math.abs(value) >= 1e5 ? 0 : Math.abs(value) < 1 && value !== 0 ? 4 : fractionDigits(code),
  }).format(value);
}

function prettyExpr(expr) {
  // Add thousands separators to each number while typing, keep a trailing "." visible.
  return expr.replace(/\d+(\.\d*)?/g, (n) => {
    const [int, dec] = n.split('.');
    return Number(int).toLocaleString('en') + (dec !== undefined ? '.' + dec : '');
  });
}

// ---------- rendering ----------
function visibleCurrencies() {
  const list = [...state.saved];
  if (state.local && !list.includes(state.local)) list.unshift(state.local);
  return list;
}

function setStatus(text, stale = false) {
  const el = document.getElementById('rates-status');
  el.textContent = text;
  el.classList.toggle('stale', stale);
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const rowEls = new Map(); // rows are kept and updated in place so animations can run

function createRow(code) {
  const row = document.createElement('div');
  row.className = 'row entering';
  row.dataset.code = code;
  row.style.viewTransitionName = `row-${code}`; // lets rows morph when the layout changes
  row.innerHTML = `
    <span class="flag">${flagFor(code)}</span>
    <div class="meta">
      <span class="code">${code}<span class="tag">📍 HERE</span></span>
      <span class="name">${nameFor(code)}</span>
    </div>
    <div class="amount"><div class="value"></div><div class="expr"></div></div>
    <div class="row-actions"><button class="remove">Remove</button><button class="save">Keep</button></div>`;
  row.addEventListener('animationend', () => row.classList.remove('entering'), { once: true });
  return row;
}

// Shrinks a number's font until it fits its row, so long amounts are never cut off.
const MIN_FONT_PX = 14;
function setValue(el, text) {
  el.textContent = text;
  el.style.fontSize = '';
  const overflow = el.scrollWidth / el.clientWidth;
  if (overflow > 1) {
    const max = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = `${Math.max(MIN_FONT_PX, Math.floor((max / overflow) * 0.97))}px`;
  }
}

// Rolls a number from its previous value to the new one.
function tweenTo(el, target, code) {
  const from = el._n;
  el._n = target;
  cancelAnimationFrame(el._raf);
  if (reducedMotion || !Number.isFinite(target) || !Number.isFinite(from) || from === target) {
    setValue(el, format(target, code));
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 380);
    setValue(el, format(from + (target - from) * (1 - (1 - p) ** 3), code));
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
  el.classList.remove('bump');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('bump');
}

// ---------- bubble sizing ----------
// Each bubble is sized to fit its own number: short amounts get small bubbles,
// long ones big bubbles. If they don't all fit on screen, everything shrinks together.
const BUBBLE = { font: 18, activeFont: 30, minD: 96, activeMinD: 140, minFont: 11 };
let measurer;
function textWidth(text, px) {
  if (!measurer) {
    measurer = document.createElement('span');
    measurer.className = 'value measure';
    document.body.appendChild(measurer);
  }
  measurer.style.fontSize = `${px}px`;
  measurer.textContent = text;
  return measurer.getBoundingClientRect().width;
}

// Height a centered flex-wrap of these diameters takes in a box of width W.
function packedHeight(ds, W, gap) {
  let h = 0, lineW = 0, lineH = 0, lines = 0;
  for (const d of ds) {
    if (lineW && lineW + gap + d > W) {
      h += lineH; lines++; lineW = 0; lineH = 0;
    }
    lineW += (lineW ? gap : 0) + d;
    lineH = Math.max(lineH, d);
  }
  return h + lineH + gap * lines;
}

function sizeBubbles() {
  if (state.layout !== 'bubbles') return;
  const rowsEl = document.getElementById('rows');
  const rows = [...rowsEl.children].filter((r) => !r.classList.contains('leaving'));
  const cs = getComputedStyle(rowsEl);
  const W = rowsEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = rowsEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const gap = 10;

  const sizes = (scale) => rows.map((r) => {
    const active = r.classList.contains('active');
    const f = Math.max(BUBBLE.minFont, (active ? BUBBLE.activeFont : BUBBLE.font) * scale);
    const minD = (active ? BUBBLE.activeMinD : BUBBLE.minD) * scale;
    // The number sits across the middle, where the circle is widest (~84% usable).
    const needed = state.editing ? 0 : textWidth(r._final ?? '', f) / 0.84 + 12;
    return { r, f, d: Math.min(W, Math.max(minD, needed)) };
  });

  let scale = 1, out = sizes(scale);
  while (scale > 0.45 && packedHeight(out.map((o) => o.d), W, gap) > H) {
    scale *= 0.92;
    out = sizes(scale);
  }
  for (const { r, f, d } of out) {
    r.style.setProperty('--d', `${d}px`);
    r.style.setProperty('--f', `${f}px`);
    r.style.setProperty('--s', Math.max(0.6, scale));
  }
}

function render() {
  const codes = visibleCurrencies();
  if (!codes.includes(state.active)) state.active = codes[0];
  const amount = evaluate(state.expr);
  const hasOp = /[+−×÷%]/.test(state.expr);
  const rows = document.getElementById('rows');

  for (const [code, el] of rowEls) {
    if (codes.includes(code)) continue;
    rowEls.delete(code);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 350);
  }

  codes.forEach((code, i) => {
    let row = rowEls.get(code);
    if (!row) rowEls.set(code, (row = createRow(code)));
    const live = [...rows.children].filter((c) => !c.classList.contains('leaving'));
    if (live[i] !== row) rows.insertBefore(row, live[i] ?? null);

    const isActive = code === state.active;
    row.classList.toggle('active', isActive);
    row.classList.toggle('is-local', code === state.local);
    row.classList.toggle('is-saved', state.saved.includes(code));

    const valueEl = row.querySelector('.value');
    const exprEl = row.querySelector('.expr');
    if (isActive) {
      cancelAnimationFrame(valueEl._raf);
      valueEl._n = amount;
      row._final = state.expr && !hasOp ? prettyExpr(state.expr) : format(amount, code);
      exprEl.textContent = hasOp ? prettyExpr(state.expr) : '';
    } else {
      exprEl.textContent = '';
      row._final = format(convert(amount, state.active, code), code);
    }
  });

  document.body.classList.toggle('bubbles', state.layout === 'bubbles');
  sizeBubbles();
  // Set values after sizing, so each number is fitted to its bubble's final size.
  for (const code of codes) {
    const row = rowEls.get(code);
    const valueEl = row.querySelector('.value');
    if (code === state.active) setValue(valueEl, row._final);
    else tweenTo(valueEl, convert(amount, state.active, code), code);
  }

  document.getElementById('layout-btn').innerHTML = state.layout === 'bubbles' ? ICON_LIST : ICON_BUBBLES;

  document.getElementById('clear-key').textContent = state.expr ? 'C' : 'AC';
  document.body.classList.toggle('editing', state.editing);
  document.getElementById('edit-btn').textContent = state.editing ? 'Done' : 'Edit';

  if (state.editing) {
    setStatus(`Drag to reorder · v${APP_VERSION} ↻`);
  } else if (state.rates) {
    const age = Date.now() - state.rates.updated;
    const when = new Date(state.rates.updated).toLocaleDateString('en', { month: 'short', day: 'numeric' });
    setStatus(`Rates as of ${when}${age > STALE_AFTER_MS ? ' · tap to update' : ''}`, age > STALE_AFTER_MS);
  } else {
    setStatus('No rates yet · tap to retry', true);
  }
  store.set('cc.active', state.active);
}

// ---------- input ----------
function press(k) {
  const last = state.expr.slice(-1);
  const isOp = (c) => '+−×÷'.includes(c) && c !== '';
  const currentNumber = state.expr.split(/[+−×÷%]/).pop();

  if (k === 'C') state.expr = '';
  else if (k === '⌫') state.expr = state.expr.slice(0, -1);
  else if (k === '=') state.expr = state.expr ? toPlain(evaluate(state.expr), state.active) : '';
  else if (isOp(k)) {
    if (!state.expr) state.expr = '0';
    state.expr = isOp(last) ? state.expr.slice(0, -1) + k : state.expr + k;
  } else if (k === '%') {
    if (state.expr && !isOp(last) && last !== '%') state.expr += '%';
  } else if (k === '.') {
    if (!currentNumber.includes('.')) state.expr += currentNumber && last !== '%' ? '.' : '0.';
  } else {
    if (last === '%') return;
    if (k === '000' && (currentNumber === '' || currentNumber === '0')) k = '0';
    if (currentNumber === '0') state.expr = state.expr.slice(0, -1);
    state.expr += k;
  }
  render();
}

function toPlain(value, code) {
  if (!Number.isFinite(value)) return '';
  return String(Number(value.toFixed(fractionDigits(code))));
}

// ---------- picker ----------
const picker = document.getElementById('picker');

function openPicker() {
  document.getElementById('search').value = '';
  renderPicker('');
  picker.showModal();
}
function closePicker() {
  if (picker.open) picker.close();
  // iOS can leave the page shifted after the search keyboard closes.
  window.scrollTo(0, 0);
}

function renderPicker(query) {
  const q = query.trim().toLowerCase();
  const all = Object.keys(state.rates?.rates ?? {}).length
    ? Object.keys(state.rates.rates)
    : [...new Set(Object.values(COUNTRY_TO_CURRENCY))];
  const visible = visibleCurrencies();
  const list = document.getElementById('picker-list');
  list.innerHTML = '';

  if (!q) {
    const gps = document.createElement('li');
    gps.innerHTML = '<span class="flag">📍</span><div class="meta"><span class="code">Use GPS for local currency</span><span class="name">If the time zone guess is wrong</span></div>';
    gps.onclick = locateWithGps;
    list.appendChild(gps);
  }

  for (const code of all.sort()) {
    const name = nameFor(code);
    if (q && !code.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.className = visible.includes(code) ? 'added' : '';
    li.innerHTML = `<span class="flag">${flagFor(code)}</span><div class="meta"><span class="code">${code}</span><span class="name">${name}</span></div>`;
    li.onclick = () => {
      if (!state.saved.includes(code)) state.saved.push(code);
      store.set('cc.saved', state.saved);
      closePicker();
      render();
    };
    list.appendChild(li);
  }
}

// ---------- wiring ----------
// A liquid ripple that spreads from where you touch.
document.addEventListener('pointerdown', (e) => {
  const host = e.target.closest('.row, #keypad button, .text-btn, .status, #picker-list li');
  if (!host || reducedMotion || document.body.classList.contains('editing')) return;
  const r = host.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.2;
  const s = document.createElement('span');
  s.className = 'ripple';
  s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  host.appendChild(s);
  s.addEventListener('animationend', () => s.remove());
});

document.getElementById('keypad').addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.k;
  if (k) press(k);
});

document.getElementById('rows').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const code = row.dataset.code;
  if (e.target.closest('.remove')) {
    state.saved = state.saved.filter((c) => c !== code);
    store.set('cc.saved', state.saved);
  } else if (e.target.closest('.save')) {
    state.saved.unshift(code);
    store.set('cc.saved', state.saved);
  } else if (code !== state.active && !state.editing) {
    // Carry the current amount over so the new row starts with its converted value.
    const value = convert(evaluate(state.expr), state.active, code);
    state.expr = state.expr && Number.isFinite(value) ? toPlain(value, code) : '';
    state.active = code;
  }
  render();
});

document.getElementById('edit-btn').onclick = () => {
  state.editing = !state.editing;
  render();
};
document.getElementById('add-btn').onclick = openPicker;

// ---------- layout switch (cards <-> bubbles) ----------
const ICON_LIST = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="3" y="4" width="18" height="4" rx="2"/><rect x="3" y="10" width="18" height="4" rx="2"/><rect x="3" y="16" width="18" height="4" rx="2"/></svg>';
const ICON_BUBBLES = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="7" cy="7" r="4"/><circle cx="17" cy="7" r="4"/><circle cx="7" cy="17" r="4"/><circle cx="17" cy="17" r="4"/></svg>';

document.getElementById('layout-btn').onclick = () => {
  state.layout = state.layout === 'bubbles' ? 'list' : 'bubbles';
  store.set('cc.layout', state.layout);
  const apply = () => {
    render();
    refitAll();
  };
  // Safari 18+ morphs each card into its bubble; older browsers just switch.
  if (document.startViewTransition && !reducedMotion) document.startViewTransition(apply);
  else apply();
};

// ---------- drag to reorder (Edit mode) ----------
// The auto-detected local currency stays pinned on top until you tap Keep.
const isDraggable = (row) => row && !row.classList.contains('leaving') && row.classList.contains('is-saved');

// Animates rows from where they were to where they are now (FLIP), using the
// `translate` property so it doesn't fight the wiggle animation's `transform`.
function flip(mutate, skip) {
  const rows = [...document.querySelectorAll('#rows .row')];
  const before = new Map(rows.map((r) => [r, r.getBoundingClientRect()]));
  mutate();
  for (const r of rows) {
    if (r === skip) continue;
    const a = before.get(r), b = r.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (!dx && !dy) continue;
    r.style.transition = 'none';
    r.style.translate = `${dx}px ${dy}px`;
    // While a row slides into place it can pass back under the finger; ignore it as a
    // drop target until it settles, or the two rows would keep swapping.
    r.dataset.flipping = '1';
    clearTimeout(r._flipTimer);
    r._flipTimer = setTimeout(() => delete r.dataset.flipping, 320);
    requestAnimationFrame(() => {
      r.style.transition = 'translate .3s cubic-bezier(.2, .9, .3, 1.2)';
      r.style.translate = '';
    });
  }
}

let drag = null;
const rowsEl = document.getElementById('rows');

rowsEl.addEventListener('pointerdown', (e) => {
  if (!state.editing || e.target.closest('button')) return;
  const row = e.target.closest('.row');
  if (!isDraggable(row)) return;
  const r = row.getBoundingClientRect();
  drag = { row, id: e.pointerId, grabX: e.clientX - r.left, grabY: e.clientY - r.top, started: false, x0: e.clientX, y0: e.clientY };
  row.setPointerCapture(e.pointerId);
});

rowsEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const { row } = drag;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
    drag.started = true;
    row.classList.add('dragging');
  }
  // Where the row would sit without any offset, then offset it to follow the finger.
  const place = () => {
    row.style.translate = '';
    const r = row.getBoundingClientRect();
    row.style.translate = `${e.clientX - drag.grabX - r.left}px ${e.clientY - drag.grabY - r.top}px`;
  };
  place();

  row.style.pointerEvents = 'none';
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.row');
  row.style.pointerEvents = '';
  if (target && target !== row && isDraggable(target) && !target.dataset.flipping) {
    const all = [...rowsEl.children];
    const after = all.indexOf(row) < all.indexOf(target);
    flip(() => rowsEl.insertBefore(row, after ? target.nextSibling : target), row);
    place();
  }

  // Scroll the list when dragging near its top or bottom edge.
  const box = rowsEl.getBoundingClientRect();
  if (e.clientY < box.top + 40) rowsEl.scrollBy(0, -8);
  else if (e.clientY > box.bottom - 40) rowsEl.scrollBy(0, 8);
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { row, started } = drag;
  drag = null;
  if (!started) return;
  row.classList.remove('dragging');
  row.style.transition = 'translate .35s cubic-bezier(.2, .9, .3, 1.2)';
  row.style.translate = '';
  const order = [...rowsEl.children].filter((r) => !r.classList.contains('leaving')).map((r) => r.dataset.code);
  state.saved = order.filter((c) => state.saved.includes(c));
  store.set('cc.saved', state.saved);
}
rowsEl.addEventListener('pointerup', endDrag);
rowsEl.addEventListener('pointercancel', endDrag);
document.getElementById('picker-close').onclick = closePicker;
document.getElementById('search').oninput = (e) => renderPicker(e.target.value);
document.getElementById('rates-status').onclick = async () => {
  if (!state.editing) return refreshRates(true);
  // In Edit mode the pill shows the version; tapping it checks for an update.
  setStatus('Checking for updates…');
  try {
    await swReg?.update();
  } catch {}
  if (swReg?.installing || swReg?.waiting) setStatus('Updating…'); // reloads itself when ready
  else {
    setStatus(`Up to date · v${APP_VERSION}`);
    setTimeout(render, 2000);
  }
};

// Re-fit numbers when the screen size changes (rotation, font load).
const refitAll = () => {
  sizeBubbles();
  document.querySelectorAll('.row .value').forEach((el) => setValue(el, el.textContent));
};
addEventListener('resize', refitAll);
document.fonts?.ready.then(() => dispatchEvent(new Event('resize')));

// Re-check location and rates whenever the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // iOS often resumes the app instead of relaunching it, so look for a new version here too.
  swReg?.update().catch(() => {});
  detectLocalCurrency();
  render();
  refreshRates();
});

let swReg = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => (swReg = r)).catch(() => {});
  // When a new version takes over, reload once so you see it right away.
  let reloaded = !navigator.serviceWorker.controller; // first install: nothing old to replace
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

detectLocalCurrency();
render();
refreshRates();
