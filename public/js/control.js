// Senate control and House control: today's split, what's on the ballot, and
// the seat calls entered by hand on /admin.html as networks project winners.

// Before tonight. Sources: Ballotpedia and Wikipedia's 2026 Senate pages (Senate),
// the House Press Gallery party breakdown (House), checked Nov 3, 2026.
export const BASELINE = {
  senate: {
    before: { R: 53, D: 45, I: 2 }, // both independents caucus with Democrats
    up: { total: 35, R: 22, D: 13 }, // 33 regular seats plus specials in Ohio and Florida
    notUp: { R: 31, D: 34 }, // D includes the two independents
    // The Vice President (a Republican) breaks 50-50 ties.
    controlR: 50,
    controlD: 51,
  },
  house: {
    before: { R: 218, D: 214, I: 1, vacant: 2 },
    up: { total: 435 },
    majority: 218,
  },
};

const fmt = new Intl.NumberFormat("en-US");

export function senateState(t) {
  const b = BASELINE.senate;
  const c = (t && t.senate) || {};
  const calledR = c.calledR || 0;
  const calledD = c.calledD || 0;
  const R = b.notUp.R + calledR;
  const D = b.notUp.D + calledD;
  const uncalled = b.up.total - calledR - calledD;
  const net = (c.flipsToD || 0) - (c.flipsToR || 0); // + = Democratic gain
  let winner = null;
  if (R >= b.controlR) winner = "R";
  else if (D >= b.controlD) winner = "D";
  return { R, D, uncalled, calledR, calledD, net, winner, needR: Math.max(0, b.controlR - R), needD: Math.max(0, b.controlD - D), total: 100 };
}

export function houseState(t) {
  const b = BASELINE.house;
  const c = (t && t.house) || {};
  const R = c.calledR || 0;
  const D = c.calledD || 0;
  const uncalled = b.up.total - R - D;
  const net = (c.flipsToD || 0) - (c.flipsToR || 0);
  let winner = null;
  if (R >= b.majority) winner = "R";
  else if (D >= b.majority) winner = "D";
  return { R, D, uncalled, calledR: R, calledD: D, net, winner, needR: Math.max(0, b.majority - R), needD: Math.max(0, b.majority - D), total: 435 };
}

function netText(net) {
  if (net === 0) return "No seats have changed parties so far.";
  const who = net > 0 ? "Democrats" : "Republicans";
  const n = Math.abs(net);
  return `${who} have a net gain of ${n} seat${n === 1 ? "" : "s"} so far.`;
}

export function headline(chamber, s) {
  const name = chamber === "senate" ? "Senate" : "House";
  if (s.winner === "R") return `Republicans keep control of the ${name}`;
  if (s.winner === "D") return `Democrats win control of the ${name}`;
  if (s.calledR + s.calledD === 0) return `No ${name} races called yet`;
  return `${name} control isn't decided yet`;
}

export function detail(chamber, s) {
  const lines = [];
  if (!s.winner) {
    const rem = `${fmt.format(s.uncalled)} uncalled`;
    if (chamber === "senate") {
      lines.push(
        `Republicans need ${s.needR} more of the ${rem} seats to keep control (50 is enough, since the Vice President breaks ties). Democrats need ${s.needD} more to reach 51.`,
      );
    } else {
      lines.push(`It takes 218 seats. Republicans need ${s.needR} more of the ${rem} seats; Democrats need ${s.needD} more.`);
    }
  }
  lines.push(netText(s.net));
  if (chamber === "senate" && !s.winner) {
    lines.push("Democrats started the night needing a net gain of 4 seats to take control; Republicans could afford a net loss of up to 3.");
  }
  return lines;
}

// The four ways tonight can shake out, given a Republican President.
const SCENARIOS = [
  {
    key: "RR",
    title: "Republicans keep both chambers",
    text: "Unified Republican control continues. The President's party can move bills and nominees through both chambers, limited mainly by the Senate filibuster.",
  },
  {
    key: "DR",
    title: "Democrats win the House, Republicans keep the Senate",
    text: "Divided government. A Democratic House elects the Speaker, controls which bills come to a vote, writes the first draft of spending bills and runs investigations. The Senate keeps confirming the President's judges and Cabinet picks.",
  },
  {
    key: "RD",
    title: "Democrats win the Senate, Republicans keep the House",
    text: "Divided government. A Democratic Senate decides which judges, Cabinet members and other nominees get confirmed, and sets the Senate's agenda. The House stays with the President's party.",
  },
  {
    key: "DD",
    title: "Democrats win both chambers",
    text: "Congress flips entirely to the party opposite the President. Democrats would set the agenda in both chambers, control nominations and investigations, and the President's main check would be the veto.",
  },
];

// Which scenarios are still possible given the calls so far.
export function scenarios(sen, hou) {
  const house = hou.winner ? [hou.winner] : ["R", "D"];
  const senate = sen.winner ? [sen.winner] : ["R", "D"];
  return SCENARIOS.map((s) => ({
    ...s,
    possible: house.includes(s.key[0]) && senate.includes(s.key[1]),
    settled: !!(hou.winner && sen.winner) && s.key === hou.winner + sen.winner,
  }));
}

// A horizontal seat bar: Republicans from the left, Democrats from the right,
// uncalled in the middle, with the control line marked.
export function seatBar(chamber, s) {
  const total = s.total;
  const w = (n) => `${((100 * n) / total).toFixed(3)}%`;
  const line = chamber === "senate" ? 50 : (100 * 217.5) / 435;
  return `<div class="seatbar" role="img" aria-label="Republicans ${s.R}, uncalled ${s.uncalled}, Democrats ${s.D}">
    <span style="width:${w(s.R)};background:var(--rep)"></span>
    <span style="width:${w(s.uncalled)};background:var(--track)"></span>
    <span style="width:${w(s.D)};background:var(--dem)"></span>
    <i class="ctl-line" style="left:${line.toFixed(3)}%"></i>
  </div>
  <div class="seat-nums">
    <span><b style="color:var(--rep)">${fmt.format(s.R)}</b> Rep.</span>
    <span class="mid">${fmt.format(s.uncalled)} uncalled</span>
    <span>Dem. <b style="color:var(--dem)">${fmt.format(s.D)}</b></span>
  </div>`;
}
