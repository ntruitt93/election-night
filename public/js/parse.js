// Turns each state's raw feed into one common shape:
//
// Race {
//   id, state: "GA"|"FL", category: "gov"|"sen"|"house"|"statewide"|"leg"|"measure"|"judicial"|"other",
//   name, district (number|null), order,
//   candidates: [{ key, name, party: "R"|"D"|"L"|"I"|"G"|"O", votes }],   sorted by votes desc
//   total, precinctsReporting, precinctsTotal,
//   counties: { [countyKey]: { name, votes: { [candidateKey]: n }, total, precinctsReporting, precinctsTotal } } | null,
//   sourceId  (GA: ballot item id, used to fetch county detail on demand)
// }

export const CATEGORY_ORDER = ["gov", "sen", "house", "statewide", "leg", "measure", "judicial", "other"];
export const CATEGORY_LABEL = {
  gov: "Governor",
  sen: "U.S. Senate",
  house: "U.S. House",
  statewide: "Other statewide offices",
  leg: "State legislature",
  measure: "Ballot measures",
  judicial: "Judicial",
  other: "Other races",
};

// "Miami-Dade" / "MIAMI-DADE COUNTY" / "St. Johns" / "Saint Johns" -> "miamidade" / "stjohns"
export function countyKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\bcounty\b/g, "")
    .replace(/\bsaint\b/g, "st")
    .replace(/[^a-z]/g, "");
}

const PARTY_WORDS = [
  [/^(r|rep|gop|republican|republican party.*)$/i, "R"],
  [/^(d|dem|democrat|democratic|democratic party.*|florida democratic party)$/i, "D"],
  [/^(l|lib|lpf|libertarian.*)$/i, "L"],
  [/^(g|grn|gre|green.*)$/i, "G"],
  [/^(i|ind|npa|independent.*|no party affiliation)$/i, "I"],
];
export function normParty(raw) {
  const s = String(raw || "").trim();
  if (!s) return "O";
  if (/republican/i.test(s)) return "R";
  if (/democrat/i.test(s)) return "D";
  for (const [re, code] of PARTY_WORDS) if (re.test(s)) return code;
  return "O";
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}

function finishRace(race) {
  race.candidates.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
  race.total = race.candidates.reduce((s, c) => s + c.votes, 0);
  return race;
}

export function sortRaces(races) {
  return races.sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      (a.district ?? 0) - (b.district ?? 0) ||
      (a.order ?? 0) - (b.order ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------- Florida

const FL_CATEGORY = {
  GOV: "gov",
  USS: "sen",
  USR: "house",
  ATG: "statewide",
  CFO: "statewide",
  AGR: "statewide",
  LTG: "statewide",
  STS: "leg",
  STR: "leg",
  AMD: "measure",
  SCJ: "judicial",
  DCA: "judicial",
  CTJ: "judicial",
  STA: "other",
  PUB: "other",
};
const FL_ORDER = { GOV: 1, ATG: 2, CFO: 3, AGR: 4 };

// Florida Division of Elections election-night file: tab-delimited, one row per
// candidate per county. Columns: ElectionDate PartyCode PartyName RaceCode
// RaceName CountyCode CountyName Juris1num Juris2num Precincts PrecinctsReporting
// CanNameLast CanNameFirst CanNameMiddle CanVotes
export function parseFlorida(text) {
  if (!text || text.trimStart().startsWith("<")) throw new Error("Florida file isn't data (got a web page)");
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split("\t").map((h) => h.trim());
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const raceNameCol = col("RaceName") >= 0 ? col("RaceName") : col("OfficeDesc");
  const C = {
    partyCode: col("PartyCode"),
    partyName: col("PartyName"),
    raceCode: col("RaceCode"),
    raceName: raceNameCol,
    countyCode: col("CountyCode"),
    countyName: col("CountyName"),
    juris1: col("Juris1num"),
    juris2: col("Juris2num"),
    precincts: col("Precincts"),
    reporting: col("PrecinctsReporting"),
    last: col("CanNameLast"),
    first: col("CanNameFirst"),
    middle: col("CanNameMiddle"),
    votes: col("CanVotes"),
  };
  for (const k of ["raceCode", "raceName", "countyName", "votes", "last"]) {
    if (C[k] < 0) throw new Error(`Florida file is missing the ${k} column`);
  }

  const seen = new Set();
  const races = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (seen.has(line)) continue; // the state's file can repeat rows
    seen.add(line);
    const f = line.split("\t");
    const get = (k) => (C[k] >= 0 ? (f[C[k]] ?? "").trim() : "");

    const code = get("raceCode");
    const raceName = get("raceName");
    if (!code && !raceName) continue;
    const j1 = get("juris1");
    const j2 = get("juris2");
    const raceId = `FL-${code}-${slug(raceName)}-${j1}-${j2}`;

    let race = races.get(raceId);
    if (!race) {
      const category = FL_CATEGORY[code] || "other";
      const m = raceName.match(/district\s*(\d+)/i);
      const district = category === "house" || category === "leg" ? (m ? +m[1] : +j1 || null) : null;
      race = {
        id: raceId,
        state: "FL",
        category,
        name: prettyFlRaceName(code, raceName, district),
        district,
        order: FL_ORDER[code] ?? 50,
        candidates: [],
        counties: {},
        precinctsReporting: 0,
        precinctsTotal: 0,
      };
      race._cand = new Map();
      races.set(raceId, race);
    }

    const first = get("first");
    const middle = get("middle");
    const last = get("last");
    // Tickets (Governor/Lt. Governor) arrive as "Last" = running mate, "First" = nominee, "Middle" = " / ".
    let name;
    if (middle === "/" || (last && first && /\//.test(middle))) name = `${first} / ${last}`;
    else name = [first, middle, last].filter((x) => x && x !== "/").join(" ").replace(/\s+/g, " ").trim();
    if (!name) name = "Unnamed";
    const partyRaw = get("partyCode") || get("partyName");
    const isWriteIn = /write/i.test(get("partyName")) || /write/i.test(name);
    const party = isWriteIn ? "O" : normParty(partyRaw);
    const candKey = slug(`${name}-${partyRaw}`);
    const votes = toNum(get("votes"));

    let cand = race._cand.get(candKey);
    if (!cand) {
      cand = { key: candKey, name: isWriteIn && !/write/i.test(name) ? `${name} (write-in)` : name, party, votes: 0 };
      race._cand.set(candKey, cand);
      race.candidates.push(cand);
    }
    cand.votes += votes;

    const ck = countyKey(get("countyName"));
    let county = race.counties[ck];
    if (!county) {
      county = race.counties[ck] = {
        name: titleCase(get("countyName")),
        votes: {},
        total: 0,
        precinctsReporting: toNum(get("reporting")),
        precinctsTotal: toNum(get("precincts")),
      };
      race.precinctsReporting += county.precinctsReporting;
      race.precinctsTotal += county.precinctsTotal;
    }
    county.votes[candKey] = (county.votes[candKey] || 0) + votes;
    county.total += votes;
  }

  const out = [];
  for (const race of races.values()) {
    delete race._cand;
    out.push(finishRace(race));
  }
  return sortRaces(out);
}

function prettyFlRaceName(code, name, district) {
  if (code === "GOV") return "Governor";
  if (code === "USS") return "U.S. Senate";
  if (code === "USR" && district) return `U.S. House District ${district}`;
  return name;
}

// ---------------------------------------------------------------- Georgia

const text = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    const en = v.find((t) => t && (t.languageId === "en" || t.languageId == null)) || v[0];
    return String((en && en.text) || "").replace(/\s+/g, " ").trim();
  }
  if (typeof v === "object" && "text" in v) return String(v.text).trim();
  return String(v).trim();
};

const GA_STATEWIDE = /^(lieutenant governor|secretary of state|attorney general|(commissioner of )?agriculture( commissioner)?|commissioner of agriculture|(commissioner of )?insurance.*|.*insurance commissioner|state school superintendent|(commissioner of )?labor( commissioner)?|public service commission.*|psc\b.*)$/i;

export function classifyGa(name) {
  const full = name.replace(/\s+/g, " ").trim();
  // Primary-style contests end in " - Rep" / " - Dem"; keep that in the label.
  const sfx = full.match(/\s+-\s+(Rep|Dem|Lib|NP)$/i);
  const n = sfx ? full.slice(0, sfx.index) : full;
  const out = classifyGaBase(n);
  if (sfx) out.label = `${out.label} (${sfx[1]})`;
  return out;
}

function classifyGaBase(n) {
  const district = (n.match(/district\s*(?:no\.?\s*)?(\d+)/i) || [])[1];
  if (/^governor$/i.test(n)) return { category: "gov", district: null, label: "Governor", order: 1 };
  if (/^(us|u\.s\.?|united states) senat/i.test(n)) return { category: "sen", district: null, label: "U.S. Senate", order: 1 };
  if (/^(us|u\.s\.?|united states) (house|representative)/i.test(n))
    return { category: "house", district: district ? +district : null, label: district ? `U.S. House District ${+district}` : n, order: 1 };
  if (/^state (senate|house)/i.test(n)) return { category: "leg", district: district ? +district : null, label: n, order: /senate/i.test(n) ? 1 : 2 };
  if (/amendment|referendum|question|^shall\b/i.test(n)) return { category: "measure", district: null, label: n, order: 1 };
  if (/judge|justice|court/i.test(n)) return { category: "judicial", district: null, label: n, order: 1 };
  if (GA_STATEWIDE.test(n)) return { category: "statewide", district: null, label: n, order: 2 };
  return { category: "other", district: null, label: n, order: 9 };
}

// GA candidate names may carry "(Rep)", "(Dem)" and an incumbent "(I)" marker.
export function gaCandidate(option) {
  let name = text(option.name);
  let party = "";
  const p = option.party || option.politicalParty;
  if (p && typeof p === "object") party = p.abbreviation || text(p.name);
  else if (p) party = text(p);
  let changed = true;
  while (changed) {
    changed = false;
    const m = name.match(/\s*\(([A-Za-z.]{1,12})\)\s*$/);
    if (m) {
      const tag = m[1];
      if (/^i$/i.test(tag)) {
        name = name.slice(0, m.index).trim();
        changed = true;
      } else if (normParty(tag) !== "O" || /^(rep|dem|lib|grn|ind|np)$/i.test(tag)) {
        if (!party) party = tag;
        name = name.slice(0, m.index).trim();
        changed = true;
      }
    }
  }
  const writeIn = option.isWriteIn === true || /^write-?in/i.test(name);
  return { name: name || "Unnamed", party: writeIn ? "O" : normParty(party), writeIn };
}

// Statewide summary: /api/ga/e/{slug}/data, plus /ballot-items for precinct reporting.
export function parseGeorgiaSummary(data, ballotItems) {
  const items = (data && (data.ballotItems || (data.results && data.results.ballotItems))) || [];
  const statusById = new Map();
  const statusByName = new Map();
  const idByName = new Map();
  for (const b of (ballotItems && (ballotItems.data || ballotItems.ballotItems || ballotItems)) || []) {
    if (!b || typeof b !== "object") continue;
    const nm = text(b.name).toLowerCase();
    if (b.reportingStatus) {
      statusById.set(b.id, b.reportingStatus);
      statusByName.set(nm, b.reportingStatus);
    }
    if (b.id) idByName.set(nm, b.id);
  }

  const races = [];
  items.forEach((item, idx) => {
    const name = text(item.name);
    if (!name) return;
    const cls = classifyGa(name);
    const options = (item.summaryResults && item.summaryResults.ballotOptions) || item.ballotOptions || [];
    const cands = [];
    const byKey = new Map();
    for (const o of options) {
      const c = gaCandidate(o);
      const key = slug(`${c.name}-${c.party}`);
      const votes = toNum(o.voteCount);
      if (byKey.has(key)) {
        byKey.get(key).votes += votes;
        continue;
      }
      const cand = { key, name: c.writeIn && !/write/i.test(c.name) ? `${c.name} (write-in)` : c.name, party: c.party, votes };
      byKey.set(key, cand);
      cands.push(cand);
    }
    const sourceId = item.id || idByName.get(name.toLowerCase()) || null;
    const st = statusById.get(item.id) || statusByName.get(name.toLowerCase()) || item.reportingStatus || null;
    const pr = st ? toNum(st.reportingUnits) : toNum(item.precinctsReporting);
    const pt = st ? toNum(st.totalUnits) : toNum(item.precinctsParticipating);
    races.push(
      finishRace({
        id: `GA-${sourceId || slug(name)}`,
        state: "GA",
        category: cls.category,
        name: cls.label,
        district: cls.district,
        order: (cls.order ?? 5) * 1000 + (toNum(item.ballotOrder) || idx),
        candidates: cands,
        counties: null,
        precinctsReporting: pr,
        precinctsTotal: pt,
        sourceId,
      }),
    );
  });
  return sortRaces(races);
}

// County detail for one race: /api/ga/e/{slug}/ballot-item/{id}. Fills race.counties
// using the same candidate keys as the statewide summary.
export function applyGeorgiaBreakdown(race, detail) {
  const bd = detail && (detail.ballotItemWithBreakdown || detail);
  const rows = (bd && bd.breakdownResults) || [];
  const counties = {};
  const known = new Map(race.candidates.map((c) => [c.key, c]));
  for (const r of rows) {
    const cname = text(r.locality && r.locality.name) || text(r.name);
    if (!cname) continue;
    const ck = countyKey(cname);
    const st = r.precinctReportingStatus || {};
    const county = (counties[ck] = counties[ck] || {
      name: titleCase(cname.replace(/\s+county$/i, "")),
      votes: {},
      total: 0,
      precinctsReporting: toNum(st.reportingUnits),
      precinctsTotal: toNum(st.totalUnits),
    });
    for (const o of r.ballotOptions || []) {
      const c = gaCandidate(o);
      let key = slug(`${c.name}-${c.party}`);
      if (!known.has(key)) {
        // Party may be missing on one side; fall back to matching by name.
        const byName = race.candidates.find((x) => slug(x.name) === slug(c.name));
        if (byName) key = byName.key;
      }
      const v = toNum(o.voteCount);
      county.votes[key] = (county.votes[key] || 0) + v;
      county.total += v;
    }
  }
  race.counties = counties;
  return race;
}

// From /api/ga/elections: tonight's general election id.
export function findGeorgiaElection(list, isoDate = "2026-11-03") {
  const els = (list && list.elections) || [];
  const sameDay = els.filter((e) => String(e.electionDate || "").slice(0, 10) === isoDate && e.publicElectionId);
  const pick =
    sameDay.find((e) => /general/i.test(text(e.name)) && !/recount|runoff/i.test(text(e.name))) ||
    sameDay.find((e) => !/recount/i.test(text(e.name))) ||
    sameDay[0];
  return pick ? { id: pick.publicElectionId, name: text(pick.name) } : null;
}

// ---------------------------------------------------------------- helpers

export function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseInt(String(v || "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function titleCase(s) {
  s = String(s || "").trim();
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bMc([a-z])/g, (m, a) => "Mc" + a.toUpperCase());
}

export { text as gaText };
