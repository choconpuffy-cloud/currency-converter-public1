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

function render() {
  const codes = visibleCurrencies();
  if (!codes.includes(state.active)) state.active = codes[0];
  const amount = evaluate(state.expr);
  const rows = document.getElementById('rows');
  rows.innerHTML = '';

  for (const code of codes) {
    const isActive = code === state.active;
    const isLocal = code === state.local;
    const isSaved = state.saved.includes(code);
    const value = isActive ? amount : convert(amount, state.active, code);
    const hasOp = /[+−×÷%]/.test(state.expr);

    const row = document.createElement('div');
    row.className = 'row' + (isActive ? ' active' : '');
    row.dataset.code = code;
    row.innerHTML = `
      <span class="flag">${flagFor(code)}</span>
      <div class="meta">
        <span class="code">${code}${isLocal ? '<span class="tag">📍 HERE</span>' : ''}</span>
        <span class="name">${nameFor(code)}</span>
      </div>
      <div class="amount">
        <div class="value">${isActive && !hasOp && state.expr ? prettyExpr(state.expr) : format(value, code)}</div>
        ${isActive && hasOp ? `<div class="expr">${prettyExpr(state.expr)}</div>` : ''}
      </div>
      <div class="row-actions">
        ${isSaved ? '<button class="remove">Remove</button>' : '<button class="save">Keep</button>'}
      </div>`;
    rows.appendChild(row);
  }

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
