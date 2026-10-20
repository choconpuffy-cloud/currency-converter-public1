import { evaluate } from './calc.js';
import { COUNTRY_TO_CURRENCY, flagFor, nameFor } from './currencies.js';
import { TZ_TO_COUNTRY } from './tz-map.js';

const RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const REFRESH_AFTER_MS = 6 * 3600e3;
const STALE_AFTER_MS = 3 * 86400e3;
const GPS_TTL_MS = 12 * 3600e3;
const DEFAULT_SAVED = ['VND', 'USD'];

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

// ---------- state ----------
const state = {
  saved: store.get('cc.saved', DEFAULT_SAVED), // persists until you remove it
  local: null, // auto-detected from location; never persisted, so it drops off when you leave
  localSource: '',
  rates: store.get('cc.rates', null), // { rates: {CODE: perUSD}, updated: ms }
  active: store.get('cc.active', DEFAULT_SAVED[0]),
  expr: '',
  editing: false,
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
    maximumFractionDigits: Math.abs(value) < 1 && value !== 0 ? 4 : fractionDigits(code),
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

// Fixed color per currency, so a row keeps its color wherever it sits in the list.
const HUES = {
  VND: 350, USD: 145, MYR: 45, PHP: 215, SGD: 15, EUR: 255,
  THB: 285, JPY: 320, GBP: 190, KRW: 175, AUD: 100, IDR: 75,
};
function hueFor(code) {
  if (code in HUES) return HUES[code];
  let h = 0;
  for (const c of code) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const rowEls = new Map(); // rows are kept and updated in place so animations can run

function createRow(code) {
  const row = document.createElement('div');
  row.className = 'row entering';
  row.dataset.code = code;
  row.style.setProperty('--h', hueFor(code));
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

// Rolls a number from its previous value to the new one.
function tweenTo(el, target, code) {
  const from = el._n;
  el._n = target;
  cancelAnimationFrame(el._raf);
  if (reducedMotion || !Number.isFinite(target) || !Number.isFinite(from) || from === target) {
    el.textContent = format(target, code);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 380);
    el.textContent = format(from + (target - from) * (1 - (1 - p) ** 3), code);
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
  el.classList.remove('bump');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('bump');
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
      valueEl.textContent = state.expr && !hasOp ? prettyExpr(state.expr) : format(amount, code);
      exprEl.textContent = hasOp ? prettyExpr(state.expr) : '';
    } else {
      exprEl.textContent = '';
      tweenTo(valueEl, convert(amount, state.active, code), code);
    }
  });

  // The background blobs take on the colors of your top currencies.
  document.querySelectorAll('.blob').forEach((b, i) => b.style.setProperty('--h', hueFor(codes[i % codes.length])));

  document.getElementById('clear-key').textContent = state.expr ? 'C' : 'AC';
  document.body.classList.toggle('editing', state.editing);
  document.getElementById('edit-btn').textContent = state.editing ? 'Done' : 'Edit';

  if (state.rates) {
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
document.getElementById('picker-close').onclick = closePicker;
document.getElementById('search').oninput = (e) => renderPicker(e.target.value);
document.getElementById('rates-status').onclick = () => refreshRates(true);

// Re-check location and rates whenever the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  detectLocalCurrency();
  render();
  refreshRates();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

detectLocalCurrency();
render();
refreshRates();
