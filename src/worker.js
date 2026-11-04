// Cloudflare Worker: serves the dashboard (static files in /public) and a small,
// cached proxy for the two official results feeds, which don't allow browser
// cross-origin requests. Only the specific upstream URLs below can be reached.

const GA_API = "https://results.sos.ga.gov/results/public/api";
const FL_FILES = "https://flelectionfiles.floridados.gov/enightfilespublic";
const ELECTION_DATE = "20261103";

const FRESH_SECONDS = 30; // how long a cached copy is served before re-fetching
const BACKUP_SECONDS = 60 * 60 * 24; // last good copy, used if the state site errors
const UPSTREAM_TIMEOUT_MS = 20000;
const USER_AGENT = "Mozilla/5.0 (compatible; FamilyElectionDashboard/1.0; +unofficial results viewer)";

const SLUG = /^[A-Za-z0-9_-]{1,80}$/;
const ITEM_ID = /^[A-Za-z0-9-]{1,64}$/;
const DATE = /^\d{8}$/;

import { handleControl } from "./control.js";
import { handleForecast } from "./forecast.js";
export { Tally } from "./control.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/forecast") {
      try {
        return await handleForecast(env, ctx, url);
      } catch (err) {
        return json({ error: String(err && err.message ? err.message : err) }, 502);
      }
    }
    if (url.pathname === "/api/control") {
      try {
        return await handleControl(request, env);
      } catch (err) {
        return json({ error: String(err && err.message ? err.message : err) }, 500);
      }
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      try {
        return await handleApi(url, ctx);
      } catch (err) {
        return json({ error: String(err && err.message ? err.message : err) }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(url, ctx) {
  const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);

  // /api/fl            -> tonight's Florida results file
  // /api/fl?date=YYYYMMDD -> a past election's file (for testing)
  if (parts[0] === "fl" && parts.length === 1) {
    const date = url.searchParams.get("date") || ELECTION_DATE;
    if (!DATE.test(date)) return json({ error: "bad date" }, 400);
    const file = `${FL_FILES}/${date}_ElecResultsFL.txt`;
    // Florida's download links carry a version number (?v=...) on election night;
    // asking without it can return an older cached copy of the file.
    const v = date === ELECTION_DATE ? await flVersion() : null;
    const upstream = `${file}?v=${encodeURIComponent(v || String(Math.floor(Date.now() / 30000)))}`;
    return proxy(upstream, "text", ctx, file);
  }

  if (parts[0] === "ga") {
    // /api/ga/elections -> list of Georgia elections (to find tonight's id)
    if (parts.length === 2 && parts[1] === "elections") {
      return proxy(`${GA_API}/jurisdictions/Georgia`, "json", ctx);
    }
    // /api/ga/e/{slug}[/data | /ballot-items | /ballot-item/{id}]
    if (parts[1] === "e" && parts[2] && SLUG.test(parts[2])) {
      const base = `${GA_API}/elections/Georgia/${parts[2]}`;
      const rest = parts.slice(3);
      if (rest.length === 0) return proxy(base, "json", ctx);
      if (rest.length === 1 && rest[0] === "data") return proxy(`${base}/data`, "json", ctx);
      if (rest.length === 1 && rest[0] === "ballot-items") return proxy(`${base}/ballot-items`, "json", ctx);
      if (rest.length === 2 && rest[0] === "ballot-item" && ITEM_ID.test(rest[1])) {
        return proxy(`${base}/data/ballot-item/${rest[1]}`, "json", ctx);
      }
    }
  }

  // /api/health -> quick check that both upstream sites answer
  // /api/check-texas -> one request to Texas's official results site, to see
  // whether it answers automated requests or shows a bot check.
  if (parts[0] === "check-texas") {
    const target = "https://results.texas-election.com/";
    const started = Date.now();
    try {
      const res = await fetch(target, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json" },
        signal: AbortSignal.timeout(15000),
        cf: { cacheTtl: 0 },
        redirect: "follow",
      });
      const text = await res.text();
      const challenged =
        res.headers.get("cf-mitigated") === "challenge" || /just a moment|cf-chl|challenge-platform|attention required/i.test(text);
      const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || null;
      return json({
        checked: target,
        verdict: challenged ? "blocked by a bot check" : res.ok ? "reachable" : `answered with HTTP ${res.status}`,
        status: res.status,
        botCheck: challenged,
        finalUrl: res.url,
        contentType: res.headers.get("content-type"),
        server: res.headers.get("server"),
        pageTitle: title && title.trim().slice(0, 120),
        bytes: text.length,
        ms: Date.now() - started,
      });
    } catch (err) {
      return json({ checked: target, verdict: "no answer", error: short(err), ms: Date.now() - started });
    }
  }

  if (parts[0] === "health") {
    const [ga, fl] = await Promise.all([
      probe(`${GA_API}/jurisdictions/Georgia`, "json"),
      flVersion().then(async (v) => {
        const p = await probe(`${FL_FILES}/${ELECTION_DATE}_ElecResultsFL.txt?v=${encodeURIComponent(v || Date.now())}`, "text");
        return { ...p, version: v || "not found on Downloads page" };
      }),
    ]);
    return json({ checkedAt: new Date().toISOString(), georgia: ga, florida: fl });
  }

  return json({ error: "not found" }, 404);
}

// Fetch an upstream URL through the edge cache. Serves a fresh cached copy when
// one exists, otherwise fetches; if the fetch fails, serves the last good copy.
// The version number Florida's own Downloads page links to right now.
let flVersionCache = { at: 0, v: null };
async function flVersion() {
  if (Date.now() - flVersionCache.at < 20000 && flVersionCache.v) return flVersionCache.v;
  try {
    const res = await fetch("https://floridaelectionwatch.gov/Downloads", {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(8000),
      cf: { cacheTtl: 0 },
    });
    const html = await res.text();
    const m = html.match(/ElecResultsFL\.txt\?v=([A-Za-z0-9]+)/);
    if (m) flVersionCache = { at: Date.now(), v: m[1] };
  } catch {}
  return flVersionCache.v;
}

async function proxy(upstream, kind, ctx, cacheName = upstream) {
  const cache = caches.default;
  const freshKey = new Request(`https://cache.internal/fresh/${encodeURIComponent(cacheName)}`);
  const backupKey = new Request(`https://cache.internal/backup/${encodeURIComponent(cacheName)}`);

  const hit = await cache.match(freshKey);
  if (hit) return withHeaders(hit, { "X-Cache": "HIT" });

  let body;
  let contentType;
  try {
    const res = await fetchUpstream(upstream);
    contentType = res.headers.get("content-type") || "";
    body = await res.arrayBuffer();
    validate(res.status, contentType, body, kind);
  } catch (err) {
    const backup = await cache.match(backupKey);
    if (backup) return withHeaders(backup, { "X-Cache": "STALE", "X-Upstream-Error": short(err) });
    return json({ error: `upstream unavailable: ${short(err)}`, upstream }, 502);
  }

  const type = kind === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
  const fetchedAt = new Date().toISOString();
  const make = (maxAge) =>
    new Response(body.slice(0), {
      headers: {
        "Content-Type": type,
        "Cache-Control": `public, max-age=${maxAge}`,
        "X-Fetched-At": fetchedAt,
      },
    });
  ctx.waitUntil(Promise.all([cache.put(freshKey, make(FRESH_SECONDS)), cache.put(backupKey, make(BACKUP_SECONDS))]));
  return withHeaders(make(FRESH_SECONDS), { "X-Cache": "MISS" });
}

async function fetchUpstream(upstream) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(upstream, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json, text/plain, */*" },
      cf: { cacheTtl: 0 },
    });
  } finally {
    clearTimeout(timer);
  }
}

function validate(status, contentType, body, kind) {
  if (status !== 200) throw new Error(`HTTP ${status}`);
  // A bot-check or error page comes back as HTML; don't cache it as data.
  const head = new TextDecoder().decode(body.slice(0, 200)).trimStart();
  if (/text\/html/i.test(contentType) || head.startsWith("<")) throw new Error("got an HTML page instead of data");
  if (kind === "json") JSON.parse(new TextDecoder().decode(body));
}

async function probe(upstream, kind) {
  const started = Date.now();
  try {
    const res = await fetchUpstream(upstream);
    const contentType = res.headers.get("content-type") || "";
    const body = await res.arrayBuffer();
    validate(res.status, contentType, body, kind);
    const out = { ok: true, status: res.status, bytes: body.byteLength, ms: Date.now() - started };
    if (kind === "text") {
      // How many candidate rows have votes yet (last tab-separated column).
      const lines = new TextDecoder().decode(body).split(/\r?\n/).slice(1);
      out.rowsWithVotes = lines.filter((l) => Number(l.split("\t").pop()) > 0).length;
      out.rows = lines.filter((l) => l.trim()).length;
    }
    return out;
  } catch (err) {
    return { ok: false, error: short(err), ms: Date.now() - started };
  }
}

function withHeaders(res, extra) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  out.headers.set("Cache-Control", "no-store"); // browsers always come back to the worker
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function short(err) {
  const msg = err && err.name === "AbortError" ? "timed out" : String(err && err.message ? err.message : err);
  return msg.slice(0, 200);
}
