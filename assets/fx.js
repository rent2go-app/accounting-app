/* Rent 2 Go — currency helpers (USD base, ZAR, AED) */
(function () {
  const META = {
    USD: { symbol: '$',   name: 'US Dollar',   locale: 'en-US' },
    ZAR: { symbol: 'R',   name: 'SA Rand',     locale: 'en-ZA' },
    AED: { symbol: 'AED', name: 'UAE Dirham',  locale: 'en-AE' },
  };

  // Fallback rates (per 1 USD) used only until the exchange_rates table is filled.
  // AED is pegged ~3.6725/USD. ZAR is a placeholder — set the real rate in-app.
  const DEFAULT_PER_USD = { USD: 1, ZAR: 18.3, AED: 3.6725 };

  // Build { FROM: { TO: rate } } from exchange_rates rows, with USD-anchored fill-in.
  function buildRateMap(rows) {
    const perUsd = { ...DEFAULT_PER_USD };
    (rows || []).forEach((r) => {
      if (r.from_code === 'USD') perUsd[r.to_code] = Number(r.rate);
      else if (r.to_code === 'USD') perUsd[r.from_code] = 1 / Number(r.rate);
    });
    const codes = Object.keys(META);
    const map = {};
    codes.forEach((f) => {
      map[f] = {};
      codes.forEach((t) => { map[f][t] = perUsd[t] / perUsd[f]; });
    });
    return map;
  }

  function convert(amount, from, to, rateMap) {
    if (from === to) return Number(amount);
    const r = rateMap && rateMap[from] && rateMap[from][to];
    return r ? Number(amount) * r : Number(amount);
  }

  function fmt(amount, code) {
    const m = META[code] || { symbol: code + ' ', locale: 'en-US' };
    const n = Number(amount || 0);
    try {
      return new Intl.NumberFormat(m.locale, {
        style: 'currency', currency: code, currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(n);
    } catch (e) {
      return m.symbol + n.toLocaleString(undefined, { minimumFractionDigits: 2 });
    }
  }

  window.FX = { META, DEFAULT_PER_USD, buildRateMap, convert, fmt, codes: Object.keys(META) };
})();
