// Trading Desk — Free Crypto & Forex Simulator
// Uses CoinGecko and exchangerate.host (no-auth). Persists state in localStorage.

(() => {
  // ---------- Utils ----------
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const fmt = Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
  const fmt2 = Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const fmtCurr = (c) => new Intl.NumberFormat(undefined, { style: 'currency', currency: c });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const load = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };
  const cryptoRandom = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  function toast(text, kind = 'info') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'msg';
    el.style.borderLeftColor = kind === 'error' ? 'var(--down)' : kind === 'warn' ? 'var(--warn)' : 'var(--accent)';
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 3600);
    setTimeout(() => { el.remove(); }, 4200);
  }

  // ---------- State ----------
  const state = {
    theme: load('theme', 'dark'),
    base: load('base', 'EUR'),
    player: load('player', { name: '' }),
    rates: load('rates', null),
    assets: load('assets', []), // {key,type,symbol,name,id?,pair?,price,change24h, history:[{t,p}], position:{qty,avg}, orders:[...]}
    active: load('active', null),
    coingeckoList: load('cg:list', null),
    lastRatesAt: load('ratesAt', 0),
  };

  // ---------- Providers ----------
  const API = {
    cg: 'https://api.coingecko.com/api/v3',
    fx: 'https://api.exchangerate.host',
  };

  const RateLimiter = (() => {
    let last = 0; const minInterval = 1200; // ~50/min safe
    return async (fetcher) => {
      const delta = Date.now() - last;
      if (delta < minInterval) await sleep(minInterval - delta);
      const res = await fetcher();
      last = Date.now();
      return res;
    };
  })();

  const CoinGecko = {
    async ensureList() {
      if (state.coingeckoList && Array.isArray(state.coingeckoList)) return state.coingeckoList;
      const res = await RateLimiter(() => fetch(`${API.cg}/coins/list?include_platform=false`));
      if (!res.ok) throw new Error('CoinGecko list failed');
      const data = await res.json();
      state.coingeckoList = data;
      save('cg:list', data);
      return data;
    },
    async search(query) {
      query = String(query || '').trim().toLowerCase();
      if (!query) return [];
      const list = await this.ensureList();
      const scored = [];
      for (const c of list) {
        const name = (c.name || '').toLowerCase();
        const sym = (c.symbol || '').toLowerCase();
        const id = (c.id || '').toLowerCase();
        let score = 0;
        if (id === query) score += 100;
        if (sym === query) score += 90;
        if (name === query) score += 80;
        if (id.startsWith(query)) score += 40;
        if (sym.startsWith(query)) score += 35;
        if (name.startsWith(query)) score += 30;
        if (name.includes(query)) score += 10;
        if (score > 0) scored.push({ ...c, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 10);
    },
    async price(ids, vs) {
      const u = `${API.cg}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`;
      const res = await RateLimiter(() => fetch(u));
      if (!res.ok) throw new Error('CoinGecko price failed');
      return await res.json();
    },
    async marketChart(id, vs, days = '90', interval = 'hourly') {
      const u = `${API.cg}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${encodeURIComponent(vs)}&days=${days}&interval=${interval}`;
      const res = await RateLimiter(() => fetch(u));
      if (!res.ok) throw new Error('CoinGecko chart failed');
      const js = await res.json();
      return (js.prices || []).map(([t, p]) => ({ t, p }));
    }
  };

  const Forex = {
    async latest(base) {
      const res = await fetch(`${API.fx}/latest?base=${encodeURIComponent(base)}`);
      if (!res.ok) throw new Error('FX latest failed');
      return await res.json(); // {rates:{USD:.., JPY:..}, base, date}
    },
    async timeseries(base, symbols, start, end) {
      const url = `${API.fx}/timeseries?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(symbols)}&start_date=${start}&end_date=${end}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('FX timeseries failed');
      return await res.json(); // {rates:{'YYYY-MM-DD':{USD:..}}, base}
    },
    priceOfPair(pair) {
      // rates are quoted as: 1 state.base -> X currency
      if (!state.rates || !state.rates.rates) return null;
      const rates = state.rates.rates;
      const rBase = pair.base === state.base ? 1 : rates[pair.base];
      const rQuote = pair.quote === state.base ? 1 : rates[pair.quote];
      if (!rBase || !rQuote) return null;
      return rQuote / rBase; // price of 1 base in quote
    },
    async historyOfPair(pair, days = 120) {
      const end = new Date();
      const start = new Date(end.getTime() - days * 86400000);
      const sd = start.toISOString().slice(0, 10);
      const ed = end.toISOString().slice(0, 10);
      const symbols = `${pair.base},${pair.quote}`;
      const js = await this.timeseries(state.base, symbols, sd, ed);
      const out = [];
      const dates = Object.keys(js.rates).sort();
      for (const d of dates) {
        const rb = pair.base === state.base ? 1 : js.rates[d][pair.base];
        const rq = pair.quote === state.base ? 1 : js.rates[d][pair.quote];
        if (rb && rq) out.push({ t: Date.parse(d), p: rq / rb });
      }
      return out;
    }
  };

  // ---------- Indicators ----------
  function SMA(series, n) {
    const out = Array(series.length).fill(null);
    let sum = 0;
    for (let i = 0; i < series.length; i++) {
      sum += series[i];
      if (i >= n) sum -= series[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  function RSI(series, n = 14) {
    const out = Array(series.length).fill(null);
    if (series.length < n + 1) return out;
    let gains = 0, losses = 0;
    for (let i = 1; i <= n; i++) {
      const diff = series[i] - series[i - 1];
      if (diff > 0) gains += diff; else losses += -diff;
    }
    let avgG = gains / n, avgL = losses / n;
    out[n] = 100 - (100 / (1 + (avgL === 0 ? 100 : avgG / avgL)));
    for (let i = n + 1; i < series.length; i++) {
      const diff = series[i] - series[i - 1];
      const g = diff > 0 ? diff : 0, l = diff < 0 ? -diff : 0;
      avgG = (avgG * (n - 1) + g) / n;
      avgL = (avgL * (n - 1) + l) / n;
      const rs = avgL === 0 ? 100 : avgG / avgL;
      out[i] = 100 - (100 / (1 + rs));
    }
    return out;
  }

  // ---------- Charts ----------
  function drawChart(canvas, data, opts = {}) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!data || data.length < 2) { drawNoData(ctx, w, h); return; }

    const pad = 36, padR = 60, padT = 12, padB = 24;
    const xs = data.map(d => d.t), ys = data.map(d => d.p);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const x2px = t => pad + ((t - minX) / (maxX - minX)) * (w - pad - padR);
    const y2px = p => (h - padB) - ((p - minY) / (maxY - minY)) * (h - padB - padT);

    // Grid
    const border = getComputedStyle(document.body).getPropertyValue('--border');
    ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = padT + i * (h - padB - padT) / 4;
      ctx.moveTo(pad, y); ctx.lineTo(w - padR, y);
    }
    ctx.stroke(); ctx.setLineDash([]);

    // Price line
    ctx.lineWidth = 2;
    const upColor = getComputedStyle(document.body).getPropertyValue('--up').trim() || '#41d19a';
    const downColor = getComputedStyle(document.body).getPropertyValue('--down').trim() || '#ff6b6b';
    const color = ys[ys.length - 1] >= ys[0] ? upColor : downColor;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x2px(xs[0]), y2px(ys[0]));
    for (let i = 1; i < xs.length; i++) ctx.lineTo(x2px(xs[i]), y2px(ys[i]));
    ctx.stroke();

    // SMA overlay
    if (opts.sma && opts.sma.length === ys.length) {
      ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent');
      ctx.lineWidth = 1.5; ctx.beginPath();
      let started = false;
      for (let i = 0; i < ys.length; i++) {
        const v = opts.sma[i]; if (v == null) continue;
        const X = x2px(xs[i]), Y = y2px(v);
        if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
      }
      ctx.stroke();
    }

    // Axes labels
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
    ctx.font = '12px ' + getComputedStyle(document.body).getPropertyValue('font-family');
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const yv = minY + i * (maxY - minY) / yTicks;
      const y = y2px(yv);
      ctx.fillText(fmt2.format(yv), w - padR + 6, y + 4);
    }
    const tStart = new Date(minX), tMid = new Date((minX + maxX) / 2), tEnd = new Date(maxX);
    ctx.textAlign = 'center';
    ctx.fillText(shortDate(tStart), x2px(minX), h - 6);
    ctx.fillText(shortDate(tMid), x2px((minX + maxX) / 2), h - 6);
    ctx.fillText(shortDate(tEnd), x2px(maxX), h - 6);
    ctx.textAlign = 'left';
  }

  function drawRSI(canvas, rsi) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!rsi || rsi.filter(v => v != null).length < 2) { drawNoData(ctx, w, h); return; }

    const pad = 30, padR = 30, padT = 10, padB = 18;
    const xs = rsi.map((_, i) => i);
    const minY = 0, maxY = 100;
    const x2px = i => pad + (i / (xs.length - 1)) * (w - pad - padR);
    const y2px = p => (h - padB) - ((p - minY) / (maxY - minY)) * (h - padB - padT);

    const border = getComputedStyle(document.body).getPropertyValue('--border');
    ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = padT + i * (h - padB - padT) / 4;
      ctx.moveTo(pad, y); ctx.lineTo(w - padR, y);
    }
    ctx.stroke(); ctx.setLineDash([]);

    ctx.strokeStyle = 'rgba(250, 173, 20, .6)';
    ctx.beginPath();
    ctx.moveTo(pad, y2px(70)); ctx.lineTo(w - padR, y2px(70));
    ctx.moveTo(pad, y2px(30)); ctx.lineTo(w - padR, y2px(30));
    ctx.stroke();

    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent');
    ctx.lineWidth = 1.5; ctx.beginPath();
    let started = false;
    for (let i = 0; i < rsi.length; i++) {
      const v = rsi[i]; if (v == null) continue;
      const X = x2px(i), Y = y2px(v);
      if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
    }
    ctx.stroke();

    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
    ctx.font = '12px ' + getComputedStyle(document.body).getPropertyValue('font-family');
    ctx.fillText('70', 6, y2px(70) + 4);
    ctx.fillText('30', 6, y2px(30) + 4);
  }

  function drawNoData(ctx, w, h) {
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
    ctx.font = '13px ' + getComputedStyle(document.body).getPropertyValue('font-family');
    ctx.textAlign = 'center';
    ctx.fillText('No data to display', w / 2, h / 2);
    ctx.textAlign = 'left';
  }

  function shortDate(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    return dt.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
  }

  // ---------- Portfolio & Orders ----------
  function findAsset(key) { return state.assets.find(a => a.key === key); }
  function ensureAsset(obj) {
    const exists = findAsset(obj.key);
    if (exists) return exists;
    state.assets.push(obj);
    save('assets', state.assets);
    return obj;
  }
  function setActive(key) {
    state.active = key;
    save('active', key);
    render();
    refreshActiveData(true);
  }

  function placeOrder({ type, side, qty, priceLimit, feePct }) {
    const a = findAsset(state.active);
    if (!a) { toast('Select an asset before placing an order', 'warn'); return; }
    qty = Number(qty || 0); if (!(qty > 0)) { toast('Invalid quantity', 'error'); return; }
    feePct = Number(feePct || 0); if (feePct < 0) feePct = 0;

    const mktPrice = a.price;
    let execPrice = null, status = 'open';
    if (type === 'market') { execPrice = mktPrice; status = 'filled'; }
    else if (type === 'limit') {
      priceLimit = Number(priceLimit || 0);
      if (!(priceLimit > 0)) { toast('Invalid limit price', 'error'); return; }
      if ((side === 'buy' && mktPrice <= priceLimit) || (side === 'sell' && mktPrice >= priceLimit)) {
        execPrice = mktPrice; status = 'filled';
      }
    }
    const order = {
      id: cryptoRandom(), ts: Date.now(), type, side, qty, priceLimit: priceLimit || null,
      status, execPrice: execPrice, feePct, player: state.player?.name || ''
    };
    a.orders.unshift(order);
    if (status === 'filled') applyFill(a, order);
    save('assets', state.assets);
    render();
    toast(status === 'filled' ? 'Order filled' : 'Order placed');
  }

  function applyFill(a, order) {
    const fee = (order.execPrice * order.qty) * (order.feePct / 100);
    a.position = a.position || { qty: 0, avg: 0 };
    if (order.side === 'buy') {
      const cost = order.execPrice * order.qty + fee;
      const newQty = a.position.qty + order.qty;
      const newAvg = newQty === 0 ? 0 : ((a.position.avg * a.position.qty) + cost) / newQty;
      a.position.qty = newQty;
      a.position.avg = newAvg;
    } else {
      a.position.qty = clamp(a.position.qty - order.qty, 0, 1e12);
      if (a.position.qty === 0) a.position.avg = 0;
    }
  }

  function processLimitOrders() {
    for (const a of state.assets) {
      if (!a.orders) continue;
      for (const o of a.orders) {
        if (o.status !== 'open') continue;
        const mkt = a.price; if (mkt == null) continue;
        if ((o.side === 'buy' && mkt <= o.priceLimit) || (o.side === 'sell' && mkt >= o.priceLimit)) {
          o.status = 'filled'; o.execPrice = mkt;
          applyFill(a, o);
          toast(`Limit ${o.side} filled on ${a.symbol} @ ${fmt2.format(mkt)}`);
        }
      }
    }
    save('assets', state.assets);
    renderPortfolio();
    renderOrders();
  }

  function closeAllPosition() {
    const a = findAsset(state.active);
    if (!a || !a.position || a.position.qty <= 0) { toast('No position to close', 'warn'); return; }
    const order = {
      id: cryptoRandom(), ts: Date.now(), type: 'market', side: 'sell', qty: a.position.qty, priceLimit: null,
      status: 'filled', execPrice: a.price, feePct: Number($('#orderFee').value || 0), player: state.player?.name || ''
    };
    a.orders.unshift(order);
    applyFill(a, order);
    save('assets', state.assets);
    render();
    toast('Position closed', 'warn');
  }

  function portfolioMetrics() {
    let total = 0;
    for (const a of state.assets) {
      const qty = a.position?.qty || 0;
      if (qty > 0 && a.price != null) total += qty * a.price;
    }
    return { total };
  }

  // ---------- Data refresh ----------
  async function refreshRates(force = false) {
    try {
      const age = Date.now() - (state.lastRatesAt || 0);
      if (!force && state.rates && age < 60_000) return;
      const js = await Forex.latest(state.base);
      state.rates = js; state.lastRatesAt = Date.now();
      save('rates', js); save('ratesAt', state.lastRatesAt);
      $('#connectionPill').innerHTML = 'Connection: <strong class="mini">OK</strong>';
    } catch (e) {
      console.error(e);
      toast('FX rates update failed', 'error');
      $('#connectionPill').innerHTML = 'Connection: <strong class="mini danger">Issues</strong>';
      return;
    }
  }

  async function refreshAssetPrice(a) {
    if (a.type === 'crypto') {
      const js = await CoinGecko.price([a.id], state.base.toLowerCase());
      const ob = js[a.id];
      if (ob) {
        a.price = ob[state.base.toLowerCase()];
        a.change24h = ob[state.base.toLowerCase() + '_24h_change'] || 0;
      }
    } else if (a.type === 'forex') {
      const p = Forex.priceOfPair(a.pair);
      if (p != null) { a.price = p; a.change24h = null; }
    }
  }

  async function refreshAssetHistory(a, force = false) {
    if (a._histAt && Date.now() - a._histAt < 60_000 && !force) return;
    if (a.type === 'crypto') {
      a.history = await CoinGecko.marketChart(a.id, state.base.toLowerCase(), '90', 'hourly');
    } else if (a.type === 'forex') {
      a.history = await Forex.historyOfPair(a.pair, 120);
    }
    a._histAt = Date.now();
    computeIndicators(a);
  }

  function computeIndicators(a) {
    if (!a.history || a.history.length < 5) { a.sma = null; a.rsi = null; return; }
    const prices = a.history.map(d => d.p);
    a.sma = SMA(prices, 14);
    a.rsi = RSI(prices, 14);
  }

  async function refreshAll() {
    await refreshRates();
    for (const a of state.assets) {
      try { await refreshAssetPrice(a); }
      catch (e) { console.error(e); toast(`Price error ${a.symbol}`, 'error'); }
    }
    processLimitOrders();
    renderWatchlist(); renderPortfolio(); renderActiveInfo();
  }

  async function refreshActiveData(force = false) {
    const key = state.active;
    const a = findAsset(key);
    if (!a) return;
    try {
      await refreshRates();
      await refreshAssetPrice(a);
      await refreshAssetHistory(a, force);
    } catch (e) { console.error(e); toast('Asset update failed', 'error'); }
    renderActiveInfo(); renderCharts(); processLimitOrders();
  }

  // ---------- Parse helpers ----------
  function parsePair(input) {
    const s = String(input).toUpperCase().replace(/\s+/g, '').replace('/', '');
    const m = s.match(/^([A-Z]{3})([A-Z]{3})$/);
    if (!m) return null;
    const base = m[1], quote = m[2];
    if (base === quote) return null;
    return { base, quote };
  }

  // ---------- Rendering ----------
  function render() {
    document.documentElement.dataset.theme = state.theme === 'light' ? 'light' : 'dark';
    $('#themeToggle').checked = state.theme === 'light';
    $('#baseCurrency').value = state.base;
    $('#playerName').value = state.player?.name || '';
    renderWatchlist(); renderPortfolio(); renderOrders(); renderActiveInfo(); renderCharts();
  }

  function renderWatchlist() {
    const box = $('#watchlist'); box.innerHTML = '';
    if (state.assets.length === 0) {
      const el = document.createElement('div'); el.className = 'help';
      el.textContent = 'No assets yet. Use search above and press Enter to add.'; box.appendChild(el); return;
    }
    for (const a of state.assets) {
      const row = document.createElement('div'); row.className = 'item';
      row.addEventListener('click', () => setActive(a.key));
      const left = document.createElement('div'); left.className = 'meta';
      const name = document.createElement('div');
      name.innerHTML = `<strong>${a.symbol}</strong> <span class="muted">· ${a.name}</span>`;
      const mini = document.createElement('div'); mini.className = 'mini';
      mini.textContent = a.type === 'crypto' ? 'Crypto (CoinGecko)' : 'Forex (exchangerate.host)';
      left.appendChild(name); left.appendChild(mini);

      const right = document.createElement('div'); right.className = 'right';
      const price = document.createElement('div'); price.className = 'price';
      price.textContent = a.price != null ? fmtCurr(state.base).format(a.price) : '—';
      const ch = document.createElement('span');
      ch.className = 'pill ' + (a.change24h == null ? '' : a.change24h >= 0 ? 'up' : 'down');
      ch.textContent = a.change24h == null ? '—' : (a.change24h >= 0 ? '+' : '') + fmt2.format(a.change24h) + '%';

      const del = document.createElement('button'); del.className = 'button'; del.textContent = 'Remove';
      del.addEventListener('click', (ev) => { ev.stopPropagation(); removeAsset(a.key); });

      right.appendChild(price); right.appendChild(ch); right.appendChild(del);
      row.appendChild(left); row.appendChild(right); box.appendChild(row);
    }
  }

  function removeAsset(key) {
    const idx = state.assets.findIndex(a => a.key === key);
    if (idx >= 0) {
      state.assets.splice(idx, 1);
      if (state.active === key) state.active = state.assets[0]?.key || null;
      save('assets', state.assets); save('active', state.active);
      render();
    }
  }

  function renderPortfolio() {
    const tbody = $('#portfolioTable tbody'); tbody.innerHTML = '';
    for (const a of state.assets) {
      const qty = a.position?.qty || 0;
      const avg = a.position?.avg || 0;
      const value = (qty > 0 && a.price != null) ? qty * a.price : 0;
      const pl = (qty > 0 && a.price != null) ? (a.price - avg) * qty : 0;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="nowrap">${a.symbol} <span class="mini muted">· ${a.name}</span></td>
        <td>${qty ? fmt(qty) : '—'}</td>
        <td>${a.price != null ? fmtCurr(state.base).format(a.price) : '—'}</td>
        <td class="${pl > 0 ? 'success' : pl < 0 ? 'danger' : ''}">${qty ? fmtCurr(state.base).format(pl) : '—'}</td>
        <td class="right-align">${value ? fmtCurr(state.base).format(value) : '—'}</td>
      `;
      tbody.appendChild(tr);
    }
    const { total } = portfolioMetrics();
    $('#portfolioTotal').textContent = total ? fmtCurr(state.base).format(total) : '—';
  }

  function renderOrders() {
    const a = findAsset(state.active);
    const tbody = $('#ordersTable tbody'); tbody.innerHTML = '';
    if (!a || !a.orders || a.orders.length === 0) {
      const tr = document.createElement('tr'); tr.innerHTML = `<td colspan="7" class="muted">No orders</td>`;
      tbody.appendChild(tr); return;
    }
    for (const o of a.orders) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(o.ts).toLocaleString()}</td>
        <td>${o.type}</td>
        <td>${o.side}</td>
        <td>${fmt(o.qty)}</td>
        <td>${o.execPrice ? fmtCurr(state.base).format(o.execPrice) : o.priceLimit ? fmtCurr(state.base).format(o.priceLimit) : '—'}</td>
        <td>${o.status}</td>
        <td>${o.player || '—'}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function renderActiveInfo() {
    const a = findAsset(state.active);
    $('#activeTitle').textContent = a ? `${a.symbol} · ${a.name}` : 'No asset selected';
    $('#activeType').textContent = a ? (a.type === 'crypto' ? 'Crypto' : 'Forex') : '';
    $('#activePricePill').textContent = 'Price: ' + (a && a.price != null ? fmtCurr(state.base).format(a.price) : '—');
    $('#activeChangePill').textContent = '24h: ' + (a && a.change24h != null ? (a.change24h >= 0 ? '+' : '') + fmt2.format(a.change24h) + '%' : '—');

    const smaVal = a?.sma ? a.sma[a.sma.length - 1] : null;
    $('#activeSmaPill').textContent = 'SMA(14): ' + (smaVal != null ? fmt2.format(smaVal) : '—');

    const rsiVal = a?.rsi ? a.rsi[a.rsi.length - 1] : null;
    $('#activeRsiPill').textContent = 'RSI(14): ' + (rsiVal != null ? fmt2.format(rsiVal) : '—');

    const type = $('#orderType').value;
    $('#limitPriceRow').style.display = type === 'limit' ? 'grid' : 'none';
  }

  function renderCharts() {
    const a = findAsset(state.active);
    const priceCanvas = $('#priceChart'), rsiCanvas = $('#rsiChart');
    if (!a || !a.history) {
      const ctx = priceCanvas.getContext('2d'); ctx.clearRect(0, 0, priceCanvas.width, priceCanvas.height); drawNoData(ctx, priceCanvas.width, priceCanvas.height);
      const ctx2 = rsiCanvas.getContext('2d'); ctx2.clearRect(0, 0, rsiCanvas.width, rsiCanvas.height); drawNoData(ctx2, rsiCanvas.width, rsiCanvas.height);
      return;
    }
    drawChart(priceCanvas, a.history, { sma: a.sma });
    drawRSI(rsiCanvas, a.rsi);
  }

  // ---------- Search & Add ----------
  function renderSuggestions(list) {
    const box = $('#suggestions'); box.innerHTML = '';
    if (!list || list.length === 0) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    for (const s of list) {
      const row = document.createElement('div'); row.className = 'item';
      row.innerHTML = `
        <div class="meta">
          <div><strong>${s.symbol?.toUpperCase?.() || s.symbol}</strong> <span class="muted">· ${s.name}</span></div>
          <div class="mini muted">${s.type === 'forex' ? `${s.pair.base}/${s.pair.quote}` : s.id}</div>
        </div>
        <div class="right"><button class="button primary">Add</button></div>
      `;
      row.querySelector('button').addEventListener('click', (ev) => { ev.stopPropagation(); addAsset(s); $('#suggestions').innerHTML = ''; });
      row.addEventListener('click', () => { addAsset(s); $('#suggestions').innerHTML = ''; });
      box.appendChild(row);
    }
  }

  async function handleInputChange() {
    const q = $('#addInput').value.trim();
    if (!q) { renderSuggestions([]); return; }
    const pair = parsePair(q);
    if (pair) {
      const item = { type: 'forex', key: `fx:${pair.base}${pair.quote}`, symbol: `${pair.base}${pair.quote}`, name: `${pair.base}/${pair.quote}`, pair };
      renderSuggestions([item]); return;
    }
    try {
      const res = await CoinGecko.search(q);
      const mapped = res.map(c => ({ type: 'crypto', key: `cg:${c.id}`, symbol: (c.symbol || '').toUpperCase(), name: c.name, id: c.id }));
      renderSuggestions(mapped);
    } catch (e) {
      console.error(e); toast('CoinGecko search failed', 'error');
    }
  }

  async function addAsset(item) {
    let obj;
    if (item.type === 'crypto') {
      obj = ensureAsset({ key: item.key, type: 'crypto', symbol: item.symbol, name: item.name, id: item.id, price: null, change24h: null, history: null, position: { qty: 0, avg: 0 }, orders: [] });
      setActive(obj.key);
      await refreshAssetPrice(obj);
      await refreshAssetHistory(obj, true);
    } else if (item.type === 'forex') {
      obj = ensureAsset({ key: item.key, type: 'forex', symbol: item.symbol, name: item.name, pair: item.pair, price: null, change24h: null, history: null, position: { qty: 0, avg: 0 }, orders: [] });
      setActive(obj.key);
      await refreshRates(true);
      await refreshAssetPrice(obj);
      await refreshAssetHistory(obj, true);
    }
    save('assets', state.assets);
    render();
    toast('Asset added to watchlist');
    $('#addInput').value = '';
  }

  // ---------- Events ----------
  function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

  function bindEvents() {
    $('#themeToggle').addEventListener('change', (e) => {
      state.theme = e.target.checked ? 'light' : 'dark';
      save('theme', state.theme); render();
    });
    $('#baseCurrency').addEventListener('change', async (e) => {
      state.base = e.target.value; save('base', state.base);
      await refreshAll(); await refreshActiveData(true);
    });
    $('#playerName').addEventListener('change', (e) => {
      state.player.name = e.target.value.trim(); save('player', state.player);
      renderOrders();
      toast(`Hello, ${state.player.name || 'Trader'}!`, 'info');
    });

    $('#addInput').addEventListener('input', debounce(handleInputChange, 180));
    $('#addInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const sug = $('#suggestions .item');
        if (sug) { sug.click(); }
      }
    });

    $('#orderType').addEventListener('change', renderActiveInfo);
    $('#placeOrderBtn').addEventListener('click', () => {
      placeOrder({
        type: $('#orderType').value,
        side: $('#orderSide').value,
        qty: $('#orderQty').value,
        priceLimit: $('#orderLimit').value,
        feePct: $('#orderFee').value
      });
    });
    $('#closeAllBtn').addEventListener('click', closeAllPosition);

    window.addEventListener('keydown', (e) => {
      if (e.key === '/') { e.preventDefault(); $('#addInput').focus(); $('#addInput').select(); }
      if (e.key.toLowerCase() === 'b') { e.preventDefault(); $('#orderSide').value = 'buy'; }
      if (e.key.toLowerCase() === 's') { e.preventDefault(); $('#orderSide').value = 'sell'; }
      if (e.key === 'Escape') { $('#suggestions').innerHTML = ''; }
    });

    // Periodic refresh
    setInterval(refreshAll, 30_000);
    setInterval(() => refreshActiveData(false), 40_000);

    // Resize canvases to device pixel ratio for crisp charts
    const resize = () => {
      for (const c of [$('#priceChart'), $('#rsiChart')]) {
        const rect = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const cssH = parseInt(getComputedStyle(c).height, 10);
        c.width = Math.max(400, Math.floor(rect.width * dpr));
        c.height = Math.max(120, Math.floor(cssH * dpr));
      }
      renderCharts();
    };
    window.addEventListener('resize', debounce(resize, 120));
    resize();
  }

  // ---------- Init ----------
  (async function init() {
    bindEvents();
    render();
    try {
      await refreshAll();
      if (!state.active && state.assets[0]) setActive(state.assets[0].key);
    } catch (e) {
      console.error(e); toast('Initialization error', 'error');
    }
  })();

})();
