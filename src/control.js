// Shared seat-count tally for the Senate and House control sections.
// Everyone can read it; only someone with the ADMIN_PASSCODE secret can change it.
// Stored in one Durable Object so every viewer sees the same numbers.

import { DurableObject } from "cloudflare:workers";

// Seats on tonight's ballot, used only to sanity-check what gets saved.
const LIMITS = { senate: 35, house: 435 };
const EMPTY = {
  senate: { calledR: 0, calledD: 0, flipsToR: 0, flipsToD: 0 },
  house: { calledR: 0, calledD: 0, flipsToR: 0, flipsToD: 0 },
  updatedAt: null,
};

export class Tally extends DurableObject {
  async get() {
    return (await this.ctx.storage.get("tally")) || EMPTY;
  }
  async set(next) {
    await this.ctx.storage.put("tally", next);
    return next;
  }
  // General-purpose storage, used for the forecast snapshot.
  async getValue(key) {
    return (await this.ctx.storage.get(key)) ?? null;
  }
  async putValue(key, value) {
    await this.ctx.storage.put(key, value);
    return value;
  }
}

export async function handleControl(request, env) {
  if (!env.TALLY) return json({ error: "Seat counts aren't set up on this deployment." }, 503);
  const stub = env.TALLY.get(env.TALLY.idFromName("tonight"));

  if (request.method === "GET" || request.method === "HEAD") {
    return json(await stub.get());
  }

  if (request.method === "POST") {
    if (!env.ADMIN_PASSCODE) {
      return json({ error: "No passcode set yet. Add an ADMIN_PASSCODE secret in the Worker's settings." }, 503);
    }
    const given = request.headers.get("X-Passcode") || "";
    if (!(await sameText(given, env.ADMIN_PASSCODE))) return json({ error: "Wrong passcode." }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Couldn't read that update." }, 400);
    }
    const next = { updatedAt: new Date().toISOString() };
    for (const chamber of ["senate", "house"]) {
      const c = (body && body[chamber]) || {};
      const v = {
        calledR: whole(c.calledR),
        calledD: whole(c.calledD),
        flipsToR: whole(c.flipsToR),
        flipsToD: whole(c.flipsToD),
      };
      if (v.calledR + v.calledD > LIMITS[chamber]) {
        return json({ error: `More ${chamber} seats called than are on the ballot (${LIMITS[chamber]}).` }, 400);
      }
      if (v.flipsToR > v.calledR || v.flipsToD > v.calledD) {
        return json({ error: `A party can't flip more ${chamber} seats than it has been called the winner of.` }, 400);
      }
      next[chamber] = v;
    }
    return json(await stub.set(next));
  }

  return json({ error: "method not allowed" }, 405);
}

function whole(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 0;
}

async function sameText(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
