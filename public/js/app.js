import {
  parseFlorida,
  parseGeorgiaSummary,
  applyGeorgiaBreakdown,
  findGeorgiaElection,
  countyKey,
  CATEGORY_ORDER,
  CATEGORY_LABEL,
} from "./parse.js";
import { BASELINE, senateState, houseState, headline, detail, scenarios, seatBar } from "./control.js";

// ------------------------------------------------------------------ settings

const REFRESH_SECONDS = 60;
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const FL_DATE = /^\d{8}$/.test(params.get("fldate") || "") ? params.get("fldate") : null; // test with a past file
const GA_SLUG = /^[A-Za-z0-9_-]{1,80}$/.test(params.get("gaslug") || "") ? params.get("gaslug") : null;
const GA_DATE = params.get("gadate") || "2026-11-03";
// Senate/House control tabs are parked for now; add ?congress=1 to the URL to see them.
const CONGRESS = params.has("congress");

const STATES = {
  ga: { code: "GA", name: "Georgia" },
  fl: { code: "FL", name: "Florida" },
};

const PARTY = {
  R: { label: "Rep.", color: "var(--rep)" },
  D: { label: "Dem.", color: "var(--dem)" },
  L: { label: "Lib.", color: "var(--lib)" },
  G: { label: "Green", color: "var(--grn)" },
  I: { label: "Ind.", color: "var(--ind)" },
  O: { label: "", color: "var(--oth)" },
};

// ------------------------------------------------------------------ state

const app = {
  data: { ga: null, fl: null }, // { races, status: {ok, message}, fetchedAt, sourceTime }
  control: null, // shared seat calls from /api/control
  controlError: null,
  geo: {},
  gaSlug: GA_SLUG,
  gaDetail: new Map(), // `${sourceId}` -> { fetchedCycle, detail }
  cycle: 0,
  view: "overview",
  selected: { ga: null, fl: null }, // race id per state
  county: { ga: null, fl: null },
  sort: { key: "total", dir: -1 },
  showAllCounties: false,
  lastLoad: null,
  loading: false,
};

const $main = document.getElementById("main");
const $updated = document.getElementById("updated");
const $refresh = document.getElementById("refresh");
const $feed = document.getElementById("feed-status");

// ------------------------------------------------------------------ fetching

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return { body: await res.json(), stale: res.headers.get("X-Cache") === "STALE", fetchedAt: res.headers.get("X-Fetched-At") };
}

async function getText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return { body: await res.text(), stale: res.headers.get("X-Cache") === "STALE", fetchedAt: res.headers.get("X-Fetched-At") };
}

async function loadGeorgia() {
  if (!app.gaSlug) {
    const list = await getJSON("/api/ga/elections");
    const found = findGeorgiaElection(list.body, GA_DATE);
    if (!found) {
      return {
        races: [],
        status: { ok: false, message: "Georgia hasn't posted tonight's results page yet. This checks again on every refresh." },
      };
    }
    app.gaSlug = found.id;
  }
  const base = `/api/ga/e/${encodeURIComponent(app.gaSlug)}`;
  const [data, items, meta] = await Promise.all([
    getJSON(`${base}/data`),
    getJSON(`${base}/ballot-items`).catch(() => null),
    getJSON(base).catch(() => null),
  ]);
  const races = parseGeorgiaSummary(data.body, items && items.body);
  const m = meta && meta.body;
  return {
    races,
    status: { ok: true, stale: data.stale },
    sourceTime: (m && (m.lastUpdated || m.asOf)) || data.fetchedAt,
  };
}

async function loadFlorida() {
  const url = FL_DATE ? `/api/fl?date=${FL_DATE}` : "/api/fl";
  const res = await getText(url);
  const races = parseFlorida(res.body);
  return { races, status: { ok: true, stale: res.stale }, sourceTime: res.fetchedAt };
}

async function loadGeo(key) {
  if (!app.geo[key]) {
    app.geo[key] = fetch(`/geo/${key}.json`).then((r) => r.json());
  }
  return app.geo[key];
}

async function loadControl() {
  if (DEMO) {
    const step = Math.floor(Date.now() / 60000) % 40;
    const sR = Math.min(22, Math.round(step * 0.55)), sD = Math.min(13, Math.round(step * 0.33));
    const hR = Math.min(230, step * 6), hD = Math.min(220, step * 6 - 3 > 0 ? step * 6 - 3 : 0);
    app.control = {
      senate: { calledR: sR, calledD: sD, flipsToR: step > 20 ? 1 : 0, flipsToD: step > 10 ? 2 : 0 },
      house: { calledR: hR, calledD: hD, flipsToR: Math.floor(step / 8), flipsToD: Math.floor(step / 5) },
      updatedAt: new Date().toISOString(),
    };
    return;
  }
  try {
    const res = await fetch("/api/control", { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    app.control = body;
    app.controlError = null;
  } catch (err) {
    app.controlError = String(err.message || err);
  }
}

async function loadAll() {
  if (app.loading) return;
  app.loading = true;
  $refresh.disabled = true;
  $refresh.textContent = "Refreshing…";
  app.cycle++;
  try {
    const controlLoad = CONGRESS ? loadControl() : Promise.resolve();
    if (DEMO) {
      const { demoData } = await import("./demo.js");
      const [gaGeo, flGeo] = await Promise.all([loadGeo("ga"), loadGeo("fl")]);
      const [ga, fl] = await Promise.all([
        settle(loadGeorgia()),
        settle(loadFlorida()),
      ]);
      app.data.ga = demoData("GA", ga.races || [], gaGeo);
      app.data.fl = demoData("FL", fl.races || [], flGeo);
    } else {
      const [ga, fl] = await Promise.all([settle(loadGeorgia()), settle(loadFlorida())]);
      app.data.ga = mergeStatus(app.data.ga, ga, "Georgia");
      app.data.fl = mergeStatus(app.data.fl, fl, "Florida");
    }
    await controlLoad;
    app.lastLoad = Date.now();
  } finally {
    app.loading = false;
    $refresh.disabled = false;
    $refresh.textContent = "Refresh";
  }
  render();
}

async function settle(p) {
  try {
    return await p;
  } catch (err) {
    return { races: null, status: { ok: false, error: true, message: String(err.message || err) } };
  }
}

// Keep showing the last good numbers if one refresh fails.
function mergeStatus(prev, next, name) {
  if (next.races) return { ...next, fetchedAt: Date.now() };
  if (prev && prev.races && prev.races.length) {
    return {
      ...prev,
      status: { ok: false, error: true, message: `Couldn't reach ${name}'s results just now (${next.status.message}). Showing the last numbers we got.` },
    };
  }
  return { races: [], status: { ...next.status, message: `Couldn't load ${name}'s results: ${next.status.message}` } };
}

async function ensureGaCounties(race) {
  if (!race || race.state !== "GA" || race.counties || !race.sourceId || !app.gaSlug) return;
  const cached = app.gaDetail.get(race.sourceId);
  if (cached && cached.cycle === app.cycle) {
    applyGeorgiaBreakdown(race, cached.detail);
    return;
  }
  const res = await getJSON(`/api/ga/e/${encodeURIComponent(app.gaSlug)}/ballot-item/${encodeURIComponent(race.sourceId)}`);
  app.gaDetail.set(race.sourceId, { cycle: app.cycle, detail: res.body });
  applyGeorgiaBreakdown(race, res.body);
}

// ------------------------------------------------------------------ helpers

const fmt = new Intl.NumberFormat("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (v, t) => (t > 0 ? (100 * v) / t : 0);
const pctText = (v, t) => (t > 0 ? `${pct(v, t).toFixed(1)}%` : "–");
const partyColor = (p) => (PARTY[p] || PARTY.O).color;

function reportingText(race) {
  if (!race.precinctsTotal) return race.total > 0 ? "Reporting" : "No votes yet";
  const p = pct(race.precinctsReporting, race.precinctsTotal);
  if (race.precinctsReporting === 0) return race.total > 0 ? "Early votes in" : "No votes yet";
  return `${p >= 99.95 ? "100" : p.toFixed(p < 10 ? 1 : 0)}% of precincts in`;
}

function leaderInfo(cands, total) {
  if (!total || cands.length === 0) return null;
  const [a, b] = cands;
  if (b && a.votes === b.votes) return { tie: true, margin: 0 };
  return { leader: a, margin: pct(a.votes - (b ? b.votes : 0), total) };
}

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ------------------------------------------------------------------ pieces

function tugBar(race) {
  const parts = race.candidates
    .filter((c) => c.votes > 0)
    .map((c) => `<span style="width:${pct(c.votes, race.total).toFixed(2)}%;background:${partyColor(c.party)}" title="${esc(c.name)}"></span>`)
    .join("");
  return `<div class="tug" aria-hidden="true">${parts}<i class="half"></i></div>`;
}

function candidateRows(race, { limit = 6, votes = null, total = null } = {}) {
  const t = total ?? race.total;
  const list = race.candidates
    .map((c) => ({ ...c, v: votes ? votes[c.key] || 0 : c.votes }))
    .sort((a, b) => b.v - a.v);
  const lead = leaderInfo(list.map((c) => ({ ...c, votes: c.v })), t);
  const shown = list.slice(0, limit);
  const hidden = list.length - shown.length;
  return `<ul class="cands">${shown
    .map((c, i) => {
      const minor = i >= 2 || (t > 0 && pct(c.v, t) < 5);
      const isLead = lead && !lead.tie && lead.leader.key === c.key && t > 0;
      return `<li class="cand${minor ? " minor" : ""}">
        <span class="cand-name"><i class="swatch" style="background:${partyColor(c.party)}"></i><span class="nm"><b>${esc(c.name)}</b>
          ${PARTY[c.party] && PARTY[c.party].label ? `<span class="party">${PARTY[c.party].label}</span>` : ""}
          ${isLead ? `<span class="lead-tag" style="background:${partyColor(c.party)}">Ahead</span>` : ""}</span></span>
        <span class="votes">${fmt.format(c.v)}</span>
        <span class="pct">${pctText(c.v, t)}</span>
      </li>`;
    })
    .join("")}</ul>${hidden > 0 ? `<div class="more-cands">+ ${hidden} more (${hidden === 1 ? "write-in or minor candidate" : "write-ins and minor candidates"})</div>` : ""}`;
}

// One line with a race's numbers inside a single county.
function countyLine(race, ck) {
  const c = race.counties && race.counties[ck];
  if (!c) return "";
  const parts = race.candidates
    .map((x) => ({ n: lastName(x.name), v: c.votes[x.key] || 0 }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .filter((x) => x.v > 0)
    .map((x) => `<b>${esc(x.n)}</b> ${pctText(x.v, c.total)}`);
  const rep = c.precinctsTotal ? `${Math.round(pct(c.precinctsReporting, c.precinctsTotal))}% of precincts in` : "";
  return `<p class="in-county">In ${esc(c.name)} County: ${parts.length ? parts.join(", ") : "no votes yet"}${rep && parts.length ? ` (${rep})` : ""}</p>`;
}

function raceBlock(race, { big = false, link = null, county = null } = {}) {
  const inner = `<div class="race-head"><h3 class="race-name">${esc(race.name)}</h3><span class="reporting">${esc(reportingText(race))}</span></div>
    ${tugBar(race)}
    ${candidateRows(race, { limit: big ? 8 : 4 })}
    ${county ? countyLine(race, county) : ""}`;
  if (link) return `<a class="race race-link${big ? " big" : ""}" href="${link}">${inner}</a>`;
  return `<section class="race${big ? " big" : ""}">${inner}</section>`;
}

function houseTable(stateKey, races) {
  if (!races.length) return "";
  const tally = {};
  let notIn = 0;
  for (const r of races) {
    const l = leaderInfo(r.candidates, r.total);
    if (!l || l.tie) notIn++;
    else tally[l.leader.party] = (tally[l.leader.party] || 0) + 1;
  }
  const tallyText = [
    ...Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${PARTY[p] && PARTY[p].label ? PARTY[p].label.replace(".", "") : "Other"} ahead in ${n}`),
    notIn ? `${notIn} without votes yet` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const rows = races
    .map((r) => {
      const l = leaderInfo(r.candidates, r.total);
      const who = l && !l.tie
        ? `<i class="swatch" style="background:${partyColor(l.leader.party)}"></i><b>${esc(l.leader.name)}</b>`
        : `<b style="color:var(--muted);font-weight:400">${r.total ? "Tied" : r.candidates.map((c) => c.name).slice(0, 2).join(" vs. ") || "No votes yet"}</b>`;
      const mini = r.total
        ? `<div class="mini">${r.candidates.filter((c) => c.votes).map((c) => `<span style="width:${pct(c.votes, r.total).toFixed(2)}%;background:${partyColor(c.party)}"></span>`).join("")}</div>`
        : "";
      return `<a class="house-row" href="#${stateKey}:${encodeURIComponent(r.id)}">
        <span class="dist">${r.district ?? "–"}</span>
        <span class="who">${who}</span>
        <span class="margin">${l && !l.tie ? `+${l.margin.toFixed(1)}` : ""}</span>
        ${mini}
        <span class="sub">${esc(reportingText(r))}${r.total ? `, ${fmt.format(r.total)} votes` : ""}${r.candidates.length === 1 ? ", unopposed" : ""}</span>
      </a>`;
    })
    .join("");
  return `<section class="house"><h3>U.S. House</h3><p class="house-tally">${esc(tallyText)}</p>${rows}</section>`;
}

function statusNotice(d) {
  if (!d) return `<div class="notice">Loading…</div>`;
  if (d.status && d.status.message) return `<div class="notice${d.status.error ? " error" : ""}">${esc(d.status.message)}</div>`;
  if (d.status && d.status.stale) return `<div class="notice">The state's site isn't answering right now, so these are the last numbers we got.</div>`;
  return "";
}

// ------------------------------------------------------------------ views

// ------------------------------------------------------------------ Your races (ZIP lookup)

const VOTER_LOOKUP = {
  ga: { label: "Georgia's My Voter Page", url: "https://mvp.sos.ga.gov/s/" },
  fl: { label: "Florida's voter lookup", url: "https://registration.elections.myflorida.com/CheckVoterStatus" },
};
const MY_CATEGORIES = ["gov", "sen", "statewide", "measure", "judicial", "house", "leg"];

function loadZips() {
  if (!app.zips) app.zips = fetch("/geo/zips.json").then((r) => r.json());
  return app.zips;
}

function saveMine() {
  try {
    localStorage.setItem("my-zip", JSON.stringify({ zip: app.myZip, county: app.myCounty }));
  } catch {}
}
function restoreMine() {
  try {
    const v = JSON.parse(localStorage.getItem("my-zip") || "null");
    if (v && /^\d{5}$/.test(v.zip)) {
      app.myZip = v.zip;
      app.myCounty = v.county || null;
    }
  } catch {}
}

async function mapLimit(items, n, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function zipCard({ compact = false, heading = true } = {}) {
  return `<section class="zip-card">
    ${heading ? "<h3>Your races</h3>" : ""}
    <p>Enter your ZIP code to see the governor, Senate, House and other races on your ballot, with your county's numbers.</p>
    <form class="zip-form" id="zip-form">
      <label class="visually-hidden" for="zip-input">ZIP code</label>
      <input id="zip-input" inputmode="numeric" autocomplete="postal-code" maxlength="5" pattern="[0-9]{5}" placeholder="ZIP code" value="${esc(app.myZip || "")}">
      <button type="submit">${compact ? "Show my races" : "Look up"}</button>
    </form>
  </section>`;
}

function bindZipForm() {
  const form = document.getElementById("zip-form");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const zip = document.getElementById("zip-input").value.replace(/\D/g, "").slice(0, 5);
    app.myZip = zip;
    app.myCounty = null;
    saveMine();
    if (app.view !== "me") location.hash = "#me";
    else renderMe();
  });
}

async function renderMe() {
  const head = `<section class="state-section"><div class="state-head"><h2>Your races</h2></div>${zipCard({ heading: false })}<div id="my-results"></div></section>`;
  $main.innerHTML = head;
  bindZipForm();
  const $out = document.getElementById("my-results");
  if (!app.myZip) return;
  if (!/^\d{5}$/.test(app.myZip)) {
    $out.innerHTML = `<div class="notice">Enter a 5-digit ZIP code.</div>`;
    return;
  }

  const [zips, gaGeo, flGeo] = await Promise.all([loadZips(), loadGeo("ga"), loadGeo("fl")]);
  const fipsList = zips[app.myZip];
  if (!fipsList) {
    $out.innerHTML = `<div class="notice">ZIP ${esc(app.myZip)} isn't in Georgia or Florida, or it's a P.O. box ZIP. Try the ZIP code where you live.</div>`;
    return;
  }
  const geoByFips = new Map([...gaGeo.counties, ...flGeo.counties].map((c) => [c.fips, c]));
  if (!app.myCounty || !fipsList.includes(app.myCounty)) app.myCounty = fipsList[0];
  const fips = app.myCounty;
  const stateKey = fips.startsWith("13") ? "ga" : "fl";
  const county = geoByFips.get(fips);
  const ck = countyKey(county.name);

  const pick =
    fipsList.length > 1
      ? `<div class="county-pick">ZIP ${esc(app.myZip)} crosses county lines. Showing <b>${esc(county.name)} County</b>; pick yours if that's not it.
          <div class="chips">${fipsList
            .map((f) => `<button type="button" data-fips="${f}" aria-pressed="${f === fips}">${esc(geoByFips.get(f).name)}</button>`)
            .join("")}</div></div>`
      : `<p class="prose-muted" style="margin-top:12px">ZIP ${esc(app.myZip)} is in <b>${esc(county.name)} County, ${STATES[stateKey].name}</b>.</p>`;

  const d = app.data[stateKey];
  if (!d || !d.races) {
    $out.innerHTML = pick + statusNotice(d);
    bindCountyPick();
    return;
  }

  const candidates = d.races.filter((r) => MY_CATEGORIES.includes(r.category));
  $out.innerHTML = pick + `<div class="notice">Loading your county's results…</div>`;
  bindCountyPick();

  // Georgia sends county detail one race at a time.
  if (stateKey === "ga") {
    const cycleAtStart = app.cycle;
    await mapLimit(candidates.filter((r) => r.category !== "leg"), 6, ensureGaCounties);
    if (app.view !== "me" || app.cycle !== cycleAtStart || app.myCounty !== fips) return;
  }

  const mine = candidates.filter((r) => r.counties && r.counties[ck]);
  const groups = [
    ["Statewide", mine.filter((r) => ["gov", "sen", "statewide"].includes(r.category))],
    ["U.S. House", mine.filter((r) => r.category === "house")],
    ["Ballot measures", mine.filter((r) => r.category === "measure")],
    ["State legislature", mine.filter((r) => r.category === "leg")],
    ["Judges", mine.filter((r) => r.category === "judicial")],
  ].filter(([, rs]) => rs.length);

  const lookup = VOTER_LOOKUP[stateKey];
  const splitNote = (rs, what) =>
    rs.length > 1
      ? `<p class="split-note">${esc(county.name)} County is split between ${rs.length} ${what}. Your voter registration card or <a href="${lookup.url}" rel="noopener">${lookup.label}</a> shows which one is yours.</p>`
      : "";

  const body = groups
    .map(([title, rs]) => {
      const note = title === "U.S. House" ? splitNote(rs, "congressional districts") : title === "State legislature" ? splitNote(rs.filter((r) => /senat/i.test(r.name)), "state senate districts") + splitNote(rs.filter((r) => !/senat/i.test(r.name)), "state house districts") : "";
      return `<h3 class="section-title">${esc(title)}</h3>${note}${rs.map((r) => raceBlock(r, { county: ck, link: `#${stateKey}:${encodeURIComponent(r.id)}` })).join("")}`;
    })
    .join("");

  const missing =
    stateKey === "ga"
      ? `<p class="prose-muted">State legislative and local races aren't included here. Find them in the <a href="#ga">Georgia tab</a>'s race picker.</p>`
      : `<p class="prose-muted">Local races (county, city and school board) aren't in the state's results file, so they aren't shown here.</p>`;

  $out.innerHTML = pick + (body || `<div class="notice">No races found for ${esc(county.name)} County in the state's results yet.</div>`) + missing;
  bindCountyPick();
}

function bindCountyPick() {
  document.querySelectorAll(".county-pick button[data-fips]").forEach((b) =>
    b.addEventListener("click", () => {
      app.myCounty = b.dataset.fips;
      saveMine();
      renderMe();
    }),
  );
}

// ------------------------------------------------------------------ Congress control

function controlStatus() {
  if (app.controlError && !app.control) return `<div class="notice error">Couldn't load the seat counts (${esc(app.controlError)}).</div>`;
  return "";
}

function calledNote() {
  const t = app.control && app.control.updatedAt ? new Date(app.control.updatedAt) : null;
  const when = t && !isNaN(t) ? ` Last updated ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "";
  return `Seat calls are entered by hand as the major networks project winners.${when}`;
}

function controlMini(chamber) {
  const s = chamber === "senate" ? senateState(app.control) : houseState(app.control);
  const name = chamber === "senate" ? "Senate control" : "House control";
  return `<a class="ctl-mini" href="#${chamber}">
    <span class="ctl-mini-head"><b>${name}</b><span>${esc(headline(chamber, s))}</span></span>
    ${seatBar(chamber, s)}
  </a>`;
}

function renderControl(chamber) {
  const s = chamber === "senate" ? senateState(app.control) : houseState(app.control);
  const other = chamber === "senate" ? houseState(app.control) : senateState(app.control);
  const sen = chamber === "senate" ? s : other;
  const hou = chamber === "house" ? s : other;
  const b = BASELINE[chamber];
  const name = chamber === "senate" ? "Senate control" : "House control";
  const winnerColor = s.winner === "R" ? "var(--rep)" : s.winner === "D" ? "var(--dem)" : "var(--ink)";

  const before =
    chamber === "senate"
      ? `<p>Before tonight: <b>53 Republicans, 47 Democrats</b> (45 Democrats plus 2 independents who vote with them). <b>35 seats are on the ballot</b>: 22 held by Republicans, 13 by Democrats, including special elections in Ohio and Florida. The other 65 aren't up this year, so the count starts at 31 Republicans and 34 Democrats.</p>
         <p>Control takes 51 seats, or 50 for Republicans because the Vice President breaks ties.</p>`
      : `<p>Before tonight: <b>218 Republicans, 214 Democrats</b>, 1 independent and 2 vacant seats. <b>All 435 seats are on the ballot</b>, so the count starts at zero for both parties.</p>
         <p>The majority takes <b>218 seats</b>.</p>`;

  const stateRaces = [];
  if (chamber === "senate") {
    for (const key of ["ga", "fl"]) {
      const d = app.data[key];
      const r = d && d.races && d.races.find((x) => x.category === "sen");
      if (r) stateRaces.push(raceBlock({ ...r, name: `${STATES[key].name}: U.S. Senate` }, { link: `#${key}:${encodeURIComponent(r.id)}` }));
    }
  } else {
    for (const key of ["ga", "fl"]) {
      const d = app.data[key];
      const rs = d && d.races ? d.races.filter((x) => x.category === "house") : [];
      if (rs.length) stateRaces.push(`<h4 class="sub-state">${STATES[key].name}</h4>` + houseTable(key, rs).replace("<h3>U.S. House</h3>", ""));
    }
  }

  const sc = scenarios(sen, hou);
  const scenarioList = sc
    .map(
      (x) => `<li class="scn${x.settled ? " settled" : ""}${x.possible ? "" : " ruled-out"}">
        <b>${esc(x.title)}</b>${x.settled ? ` <span class="scn-tag">Tonight's result</span>` : x.possible ? "" : ` <span class="scn-tag out">Ruled out</span>`}
        <p>${esc(x.text)}</p></li>`,
    )
    .join("");

  $main.innerHTML = `<section class="state-section">
    <div class="state-head"><h2>${name}</h2></div>
    ${controlStatus()}
    <section class="ctl">
      <p class="ctl-headline" style="color:${winnerColor}">${esc(headline(chamber, s))}</p>
      ${seatBar(chamber, s)}
      <div class="ctl-legend">${chamber === "senate" ? "Line marks 50 seats: enough for Republicans, one short for Democrats." : "Line marks the 218-seat majority."}</div>
      ${detail(chamber, s).map((l) => `<p class="ctl-detail">${esc(l)}</p>`).join("")}
      <p class="ctl-note">${esc(calledNote())}</p>
    </section>
    <h3 class="section-title">Where things started</h3>
    <div class="prose">${before}</div>
    <h3 class="section-title">What tonight could mean</h3>
    <p class="prose-muted">The President is a Republican, so control of each chamber decides how much of his agenda can pass and how much oversight he faces.</p>
    <ul class="scenarios">${scenarioList}</ul>
    ${stateRaces.length ? `<h3 class="section-title">${chamber === "senate" ? "Senate races on this page" : "House races on this page"}</h3>${stateRaces.join("")}` : ""}
  </section>`;
}

function renderOverview() {
  const out = [];
  out.push(
    app.myZip
      ? `<section class="zip-card"><h3>Your races</h3><p>See every race on your ballot for ZIP ${esc(app.myZip)}, with your county's numbers.</p><a class="zip-cta" href="#me">Show my races</a></section>`
      : zipCard({ compact: true }),
  );
  if (CONGRESS) {
    out.push(`<section class="state-section ctl-strip"><div class="state-head"><h2>Congress</h2></div>${controlStatus()}${controlMini("senate")}${controlMini("house")}</section>`);
  }
  for (const key of ["ga", "fl"]) {
    const d = app.data[key];
    const st = STATES[key];
    out.push(`<section class="state-section"><div class="state-head"><h2>${st.name}</h2><a href="#${key}">County map and all races</a></div>`);
    out.push(statusNotice(d));
    if (d && d.races) {
      const gov = d.races.filter((r) => r.category === "gov");
      const sen = d.races.filter((r) => r.category === "sen");
      const house = d.races.filter((r) => r.category === "house");
      for (const r of [...gov, ...sen]) out.push(raceBlock(r, { big: true, link: `#${key}:${encodeURIComponent(r.id)}` }));
      out.push(houseTable(key, house));
      if (!gov.length && !sen.length && !house.length && d.races.length) {
        out.push(`<div class="notice">No governor, Senate or House races found in the feed. Open the ${st.name} tab to see every race.</div>`);
      }
      if (!d.races.length && d.status && d.status.ok) {
        out.push(`<div class="notice">The results file is up but has no races in it yet.</div>`);
      }
    }
    out.push(`</section>`);
  }
  $main.innerHTML = out.join("");
  bindZipForm();
}

function defaultRace(races) {
  return (
    races.find((r) => r.category === "gov") ||
    races.find((r) => r.category === "sen") ||
    races.find((r) => r.category === "house") ||
    races[0]
  );
}

async function renderState(key) {
  const d = app.data[key];
  const st = STATES[key];
  const races = (d && d.races) || [];
  let race = races.find((r) => r.id === app.selected[key]);
  if (!race) {
    race = defaultRace(races);
    // Keep a race picked from a link until the data that contains it arrives.
    if (race) app.selected[key] = race.id;
  }

  const groups = CATEGORY_ORDER.map((cat) => [cat, races.filter((r) => r.category === cat)]).filter(([, rs]) => rs.length);
  const picker = races.length
    ? `<div class="picker"><label for="race-select">Race</label><select id="race-select">${groups
        .map(
          ([cat, rs]) =>
            `<optgroup label="${esc(CATEGORY_LABEL[cat])}">${rs
              .map((r) => `<option value="${esc(r.id)}"${race && r.id === race.id ? " selected" : ""}>${esc(r.name)}</option>`)
              .join("")}</optgroup>`,
        )
        .join("")}</select>
        <div class="quick">${["gov", "sen"]
          .map((cat) => races.find((r) => r.category === cat))
          .filter(Boolean)
          .map((r) => `<button type="button" data-race="${esc(r.id)}" aria-pressed="${race && r.id === race.id}">${esc(r.name)}</button>`)
          .join("")}</div></div>`
    : "";

  $main.innerHTML = `<section class="state-section"><div class="state-head"><h2>${st.name}</h2></div>
    ${statusNotice(d)}
    ${picker}
    ${race ? raceBlock(race, { big: true }) : ""}
    <div id="map-area">${race ? `<div class="map-wrap"><div class="map-loading">Loading county results…</div></div>` : ""}</div>
    <div id="county-area"></div>
  </section>`;

  const sel = document.getElementById("race-select");
  if (sel) sel.addEventListener("change", () => selectRace(key, sel.value));
  $main.querySelectorAll(".quick button").forEach((b) => b.addEventListener("click", () => selectRace(key, b.dataset.race)));

  if (!race) return;
  const cycleAtStart = app.cycle;
  const raceId = race.id;
  try {
    await ensureGaCounties(race);
  } catch (err) {
    if (app.view === key && app.selected[key] === raceId) {
      document.getElementById("map-area").innerHTML = `<div class="notice error">Couldn't load county results for this race (${esc(err.message)}). They'll try again on the next refresh.</div>`;
    }
    return;
  }
  const geo = await loadGeo(key);
  // The person may have moved on while we were loading.
  if (app.view !== key || app.selected[key] !== raceId || app.cycle !== cycleAtStart) return;
  drawMap(key, race, geo);
  drawCounties(key, race, geo);
}

function selectRace(key, id) {
  app.selected[key] = id;
  app.county[key] = null;
  app.showAllCounties = false;
  history.replaceState(null, "", `#${key}:${encodeURIComponent(id)}`);
  renderState(key);
}

// Fill: leader's party color, darker as the lead grows.
const BUCKETS = [
  [5, 0.3],
  [15, 0.52],
  [30, 0.75],
  [Infinity, 0.97],
];
function countyFill(race, county) {
  if (!county || !county.total) return { fill: "var(--novotes)", opacity: 1 };
  const ranked = race.candidates.map((c) => ({ ...c, votes: county.votes[c.key] || 0 })).sort((a, b) => b.votes - a.votes);
  const l = leaderInfo(ranked, county.total);
  if (!l || l.tie) return { fill: "var(--oth)", opacity: 0.6 };
  const op = BUCKETS.find(([m]) => l.margin < m)[1];
  return { fill: partyColor(l.leader.party), opacity: op };
}

function drawMap(key, race, geo) {
  const area = document.getElementById("map-area");
  if (!race.counties) {
    area.innerHTML = `<div class="notice">County results aren't available for this race.</div>`;
    return;
  }
  const inRace = new Set(Object.keys(race.counties));
  const sel = app.county[key];
  const paths = geo.counties
    .map((c) => {
      const k = countyKey(c.name);
      const county = race.counties[k];
      if (!inRace.has(k)) return `<path class="out" d="${c.d}" fill="var(--track)" opacity="0.45"><title>${esc(c.name)}: not in this race</title></path>`;
      const f = countyFill(race, county);
      const tip = county && county.total
        ? `${c.name}: ${race.candidates
            .map((x) => ({ n: x.name, v: county.votes[x.key] || 0 }))
            .sort((a, b) => b.v - a.v)
            .slice(0, 2)
            .map((x) => `${x.n} ${pctText(x.v, county.total)}`)
            .join(", ")}`
        : `${c.name}: no votes yet`;
      return `<path data-k="${k}" class="${sel === k ? "sel" : ""}" d="${c.d}" fill="${f.fill}" fill-opacity="${f.opacity}"><title>${esc(tip)}</title></path>`;
    })
    .join("");
  // Draw the selected county last so its outline sits on top.
  const parties = [...new Set(race.candidates.slice(0, 3).map((c) => c.party))].filter((p) => p !== "O" || race.candidates.length <= 3);
  const legend = parties
    .map(
      (p) =>
        `<span>${esc(race.candidates.find((c) => c.party === p).name)} ahead<span class="ramp">${BUCKETS.map(
          ([, o]) => `<i style="background:${partyColor(p)};opacity:${o}"></i>`,
        ).join("")}</span></span>`,
    )
    .join("");
  area.innerHTML = `<div class="map-wrap">
      <svg viewBox="0 0 ${geo.width} ${geo.height}" role="img" aria-label="County map of ${esc(race.name)} results">${paths}</svg>
      <div class="legend">${legend}<span>Darker = bigger lead (under 5, 15, 30, over 30 points)</span><span><i class="swatch" style="display:inline-block;background:var(--novotes)"></i> No votes yet</span></div>
    </div>`;
  const svg = area.querySelector("svg");
  const selPath = svg.querySelector("path.sel");
  if (selPath) svg.appendChild(selPath);
  svg.addEventListener("click", (e) => {
    const p = e.target.closest("path[data-k]");
    if (!p) return;
    pickCounty(key, race, geo, p.dataset.k);
  });
}

function pickCounty(key, race, geo, k) {
  app.county[key] = app.county[key] === k ? null : k;
  drawMap(key, race, geo);
  drawCounties(key, race, geo);
  if (app.county[key]) document.getElementById("county-area").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
}

function drawCounties(key, race, geo) {
  const area = document.getElementById("county-area");
  if (!race.counties) {
    area.innerHTML = "";
    return;
  }
  const sel = app.county[key];
  let card = "";
  if (sel && race.counties[sel]) {
    const c = race.counties[sel];
    const f = countyFill(race, c);
    const rep = c.precinctsTotal ? `${fmt.format(c.precinctsReporting)} of ${fmt.format(c.precinctsTotal)} precincts in` : c.total ? "" : "No votes yet";
    card = `<section class="county-card" style="border-left-color:${f.fill}">
      <h3>${esc(c.name)} County</h3><span class="reporting">${esc(rep)}${c.total ? `${rep ? ", " : ""}${fmt.format(c.total)} votes` : ""}</span>
      ${candidateRows(race, { limit: 6, votes: c.votes, total: c.total })}
    </section>`;
  }

  const rows = Object.entries(race.counties).map(([k, c]) => {
    const ranked = race.candidates.map((x) => ({ ...x, v: c.votes[x.key] || 0 })).sort((a, b) => b.v - a.v);
    const lead = c.total && ranked[0] && (!ranked[1] || ranked[0].v !== ranked[1].v) ? ranked[0] : null;
    const margin = lead ? pct(lead.v - (ranked[1] ? ranked[1].v : 0), c.total) : -1;
    const rp = c.precinctsTotal ? pct(c.precinctsReporting, c.precinctsTotal) : -1;
    return { k, c, lead, margin, rp };
  });
  const { key: sk, dir } = app.sort;
  rows.sort((a, b) => {
    let v = 0;
    if (sk === "name") v = a.c.name.localeCompare(b.c.name);
    else if (sk === "margin") v = a.margin - b.margin;
    else if (sk === "rp") v = a.rp - b.rp;
    else v = a.c.total - b.c.total;
    return v * dir || a.c.name.localeCompare(b.c.name);
  });
  const LIMIT = 15;
  const shown = app.showAllCounties ? rows : rows.slice(0, LIMIT);
  const th = (k, label) =>
    `<th scope="col" aria-sort="${sk === k ? (dir > 0 ? "ascending" : "descending") : "none"}"><button type="button" data-sort="${k}">${label}${sk === k ? (dir > 0 ? " ▲" : " ▼") : ""}</button></th>`;
  const table = rows.length > 1
    ? `<h3 class="section-title">By county</h3>
      <table class="ctable"><thead><tr>${th("name", "County")}${th("margin", "Ahead")}${th("total", "Votes")}${th("rp", "Precincts in")}</tr></thead><tbody>
      ${shown
        .map(
          (r) => `<tr data-k="${r.k}"><td>${esc(r.c.name)}</td>
          <td>${r.lead ? `<span class="m" style="color:${partyColor(r.lead.party)}">${esc(lastName(r.lead.name))} +${r.margin.toFixed(1)}</span>` : "–"}</td>
          <td>${r.c.total ? fmt.format(r.c.total) : "–"}</td>
          <td>${r.rp >= 0 ? `${Math.round(r.rp)}%` : "–"}</td></tr>`,
        )
        .join("")}
      </tbody></table>
      ${rows.length > LIMIT ? `<button type="button" class="show-all">${app.showAllCounties ? "Show fewer counties" : `Show all ${rows.length} counties`}</button>` : ""}`
    : "";
  area.innerHTML = card + table;
  area.querySelectorAll("th button").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.sort;
      app.sort = { key: k, dir: app.sort.key === k ? -app.sort.dir : k === "name" ? 1 : -1 };
      drawCounties(key, race, geo);
    }),
  );
  area.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => pickCounty(key, race, geo, tr.dataset.k)));
  const more = area.querySelector(".show-all");
  if (more) more.addEventListener("click", () => {
    app.showAllCounties = !app.showAllCounties;
    drawCounties(key, race, geo);
  });
}

function lastName(name) {
  const first = String(name).split(" / ")[0].trim();
  const parts = first.replace(/,?\s+(Jr\.?|Sr\.?|II|III|IV)$/i, "").split(/\s+/);
  return parts[parts.length - 1] || first;
}

// ------------------------------------------------------------------ routing + chrome

function readHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ""));
  const [view, raceId] = h.split(/:(.*)/s);
  app.view = ["me", "ga", "fl", ...(CONGRESS ? ["senate", "house"] : [])].includes(view) ? view : "overview";
  if (raceId && (view === "ga" || view === "fl")) {
    if (app.selected[view] !== raceId) {
      app.county[view] = null;
      app.showAllCounties = false;
    }
    app.selected[view] = raceId;
  }
}

function render() {
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.view === app.view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (app.view === "overview") renderOverview();
  else if (app.view === "me") renderMe();
  else if (app.view === "senate" || app.view === "house") renderControl(app.view);
  else renderState(app.view);
  renderChrome();
}

function renderChrome() {
  if (app.lastLoad) {
    const next = Math.max(0, REFRESH_SECONDS - Math.round((Date.now() - app.lastLoad) / 1000));
    $updated.textContent = `Updated ${timeAgo(app.lastLoad)}${autoRefreshOn() ? `, next in ${next}s` : ""}`;
  }
  const bits = [];
  for (const key of ["ga", "fl"]) {
    const d = app.data[key];
    if (!d) continue;
    const name = STATES[key].name;
    if (d.status && d.status.ok && d.sourceTime) {
      const t = new Date(d.sourceTime);
      if (!isNaN(t)) bits.push(`${name} data as of ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    } else if (d.status && !d.status.ok) bits.push(`${name}: feed problem`);
  }
  if (DEMO) bits.push("demo data");
  if (FL_DATE) bits.push(`Florida test file ${FL_DATE}`);
  if (GA_SLUG) bits.push(`Georgia test election ${GA_SLUG}`);
  $feed.textContent = bits.join(". ");
}

const autoRefreshOn = () => document.visibilityState === "visible";

setInterval(() => {
  renderChrome();
  if (autoRefreshOn() && app.lastLoad && Date.now() - app.lastLoad >= REFRESH_SECONDS * 1000) loadAll();
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && app.lastLoad && Date.now() - app.lastLoad > 20000) loadAll();
});

window.addEventListener("hashchange", () => {
  readHash();
  render();
  window.scrollTo(0, 0);
});

$refresh.addEventListener("click", () => loadAll());

if (DEMO) document.getElementById("demo-banner").hidden = false;
if (CONGRESS) document.querySelectorAll(".congress-tab").forEach((a) => (a.hidden = false));
restoreMine();
readHash();
render();
loadAll();
