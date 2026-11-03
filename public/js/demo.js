// Made-up numbers for testing the page before real results arrive (?demo=1).
// Uses tonight's real race list when the feed has one, otherwise a stand-in set.
// More counties "report" with each refresh, cycling every 40 minutes.
import { countyKey, sortRaces } from "./parse.js";

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

function stubRaces(state) {
  const pair = (r, d) => [
    { key: "rep", name: r, party: "R", votes: 0 },
    { key: "dem", name: d, party: "D", votes: 0 },
    { key: "lib", name: "Libertarian Candidate", party: "L", votes: 0 },
  ];
  const races = [
    { id: `${state}-demo-gov`, category: "gov", name: "Governor", district: null, candidates: pair("Republican Nominee", "Democratic Nominee") },
    { id: `${state}-demo-sen`, category: "sen", name: "U.S. Senate", district: null, candidates: pair("Senate Republican", "Senate Democrat") },
  ];
  for (let d = 1; d <= 6; d++) {
    races.push({ id: `${state}-demo-h${d}`, category: "house", name: `U.S. House District ${d}`, district: d, candidates: pair(`Rep. Candidate ${d}`, `Dem. Candidate ${d}`).slice(0, 2) });
  }
  return races.map((r) => ({ ...r, state, counties: null, precinctsReporting: 0, precinctsTotal: 0, total: 0 }));
}

export function demoData(state, realRaces, geo) {
  const minutes = Math.floor(Date.now() / 60000);
  const progress = 0.08 + 0.92 * ((minutes % 40) / 39);
  const races = realRaces.length ? realRaces.map((r) => ({ ...r, candidates: r.candidates.map((c) => ({ ...c })) })) : stubRaces(state);
  const allCounties = geo.counties.map((c) => ({ key: countyKey(c.name), name: c.name }));

  for (const race of races) {
    const statewide = ["gov", "sen", "statewide", "measure", "judicial"].includes(race.category);
    let counties = race.counties ? Object.entries(race.counties).map(([key, c]) => ({ key, name: c.name })) : null;
    if (!counties || !counties.length) {
      counties = statewide
        ? allCounties
        : allCounties.filter((c) => hash(`${race.id}:${c.key}`) < 0.12).slice(0, 12);
    }
    race.counties = {};
    race.precinctsReporting = 0;
    race.precinctsTotal = 0;
    for (const c of race.candidates) c.votes = 0;
    for (const c of counties) {
      const size = Math.round(2000 + 60000 * Math.pow(hash(`size:${c.key}`), 3));
      const precincts = 4 + Math.round(size / 3000);
      const reportedShare = Math.max(0, Math.min(1, (progress - hash(`t:${race.id}:${c.key}`) * 0.7) / 0.3));
      const lean = hash(`lean:${c.key}`) - 0.5 + (hash(`race:${race.id}`) - 0.5) * 0.3;
      const county = { name: c.name, votes: {}, total: 0, precinctsTotal: precincts, precinctsReporting: Math.round(precincts * reportedShare) };
      const n = race.candidates.length;
      race.candidates.forEach((cand, i) => {
        let share;
        if (cand.party === "R") share = 0.5 + lean * 0.8;
        else if (cand.party === "D") share = 0.5 - lean * 0.8;
        else share = 0.02 + 0.03 * hash(`${cand.key}:${c.key}`);
        if (!["R", "D"].includes(cand.party) && n <= 2) share = i === 0 ? 0.6 : 0.4;
        const v = Math.round(size * reportedShare * Math.max(0.01, share));
        county.votes[cand.key] = v;
        county.total += v;
        cand.votes += v;
      });
      race.counties[c.key] = county;
      race.precinctsTotal += precincts;
      race.precinctsReporting += county.precinctsReporting;
    }
    race.candidates.sort((a, b) => b.votes - a.votes);
    race.total = race.candidates.reduce((s, c) => s + c.votes, 0);
    race.sourceId = null; // keep the demo from asking Georgia for county detail
  }
  return { races: sortRaces(races), status: { ok: true }, sourceTime: null };
}
