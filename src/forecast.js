// Pre-election forecast for the Georgia and Florida governor and Senate races,
// from Kalshi's public market-data API (no login, read-only). Each race has a
// Democratic and a Republican contract; their prices give the chance each party
// wins. Once polls close the numbers start reacting to the count, so the page
// keeps the last pre-close snapshot and shows that all night.

const KALSHI_HOSTS = ["https://external-api.kalshi.com", "https://api.elections.kalshi.com"];
const EVENTS = {
  GA: { gov: "GOVPARTYGA-26", sen: "SENATEGA-26" },
  FL: { gov: "GOVPARTYFL-26", sen: "SENATEFLS-26" }, // Florida's Senate race is a special election
};
// 7:00 PM Eastern, when Georgia's and most of Florida's polls close.
const FREEZE_AT = Date.parse("2026-11-04T00:00:00Z");
const CACHE_SECONDS = 120;
const SNAPSHOT_KEY = "forecast-snapshot";

export async function handleForecast(env, ctx) {
  const store = env.TALLY ? env.TALLY.get(env.TALLY.idFromName("tonight")) : null;
  const now = Date.now();

  if (now >= FREEZE_AT && store) {
    const snap = await store.getValue(SNAPSHOT_KEY).catch(() => null);
    if (snap) return json({ ...snap, frozen: true });
  }

  const cache = caches.default;
  const key = new Request("https://cache.internal/forecast");
  let data;
  const hit = await cache.match(key);
  if (hit) data = await hit.json();
  else {
    data = await fetchAll();
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` } })));
  }

  const usable = Object.values(data.states).some((s) => Object.values(s).some((r) => r && r.D != null));
  if (store && usable && now < FREEZE_AT) {
    ctx.waitUntil(store.putValue(SNAPSHOT_KEY, data).catch(() => {}));
  }
  // frozen: false after the freeze means no pre-close snapshot was saved and these are live prices.
  return json({ ...data, frozen: false, afterClose: now >= FREEZE_AT });
}

async function fetchAll() {
  const states = {};
  const jobs = [];
  for (const [st, races] of Object.entries(EVENTS)) {
    states[st] = {};
    for (const [race, ticker] of Object.entries(races)) {
      jobs.push(
        fetchEvent(ticker)
          .then((ev) => (states[st][race] = summarize(ev)))
          .catch((err) => (states[st][race] = { error: String(err.message || err).slice(0, 120) })),
      );
    }
  }
  await Promise.all(jobs);
  return { asOf: new Date().toISOString(), source: "Kalshi", states };
}

async function fetchEvent(ticker) {
  let lastErr;
  for (const host of KALSHI_HOSTS) {
    try {
      const res = await fetch(`${host}/trade-api/v2/events/${encodeURIComponent(ticker)}?with_nested_markets=true`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Price fields come as dollar strings ("0.7100"); older responses used cents.
function price(m, name) {
  const d = m[`${name}_dollars`];
  if (d != null && d !== "") return Number(d);
  const c = m[name];
  return c != null ? Number(c) / 100 : NaN;
}

function marketChance(m) {
  const bid = price(m, "yes_bid");
  const ask = price(m, "yes_ask");
  const last = price(m, "last_price");
  if (bid > 0 && ask > 0 && ask - bid <= 0.1) return (bid + ask) / 2;
  if (last > 0) return last;
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return NaN;
}

export function summarize(ev) {
  const markets = (ev && (ev.markets || (ev.event && ev.event.markets))) || [];
  const out = { D: null, R: null, names: {} };
  for (const m of markets) {
    const party = (String(m.ticker || "").match(/-([DR])$/) || [])[1];
    if (!party) continue;
    const p = marketChance(m);
    if (Number.isFinite(p)) out[party] = p;
    if (m.yes_sub_title) out.names[party] = m.yes_sub_title;
  }
  if (out.D == null || out.R == null) return { error: "market prices unavailable" };
  const sum = out.D + out.R;
  out.D = Math.round((1000 * out.D) / sum) / 10;
  out.R = Math.round(1000 - 10 * out.D) / 10;
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
