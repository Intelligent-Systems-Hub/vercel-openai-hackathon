import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { casting, FIXTURE_ROOT, loadPair, loadRole, type RoleName } from "@/lib/fixtures";

import { canonicalJson, requestDigest } from "./digest";
import { dayOffset, replay, ReplayMiss, replayPinned } from "./index";
import { match } from "./match";
import { addDays, daysBetween, shiftDates } from "./shift";

const index: { pairs: { fullPath: string; digest: string }[] } = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, "gds", "index.json"), "utf8"),
);

// The demo day used throughout: the storm hits on the trip's departure day.
const DEMO = "2026-09-29";
const OFFSET = daysBetween(casting.captureDepart, DEMO); // 61

/** What our own code will send on demo day: the recorded request, moved onto the demo calendar. */
const demoRequest = (role: RoleName) => shiftDates(loadRole(role).request, OFFSET);

/** Every travel date in a parsed body, in document order. */
function travelDates(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((v) => travelDates(v, out));
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) {
      if (/^(departure|arrival|checkIn|checkOut|start|end)Date$/.test(k) && typeof v === "string") out.push(v);
      else travelDates(v, out);
    }
  return out;
}

describe("digest", () => {
  it.each(index.pairs.map((p) => [p.fullPath, p.digest]))(
    "reproduces the recorded digest for %s %s",
    (path, digest) => {
      expect(requestDigest(loadPair(path, digest).request)).toBe(digest);
    },
  );

  it("matches Python's canonical form: sorted keys, tight separators, escaped non-ASCII", () => {
    expect(canonicalJson({ b: [1, true, null], a: "Léa" })).toBe('{"a":"L\\u00e9a","b":[1,true,null]}');
  });
});

describe("shift", () => {
  it("moves only travel dates, by whole days, and undoes cleanly", () => {
    const value = {
      departureDate: "2026-07-30",
      departureTime: "18:05:00",
      stay: { checkInDate: "2026-07-31", birthDate: "2025-06-15" },
      createdAt: "2026-07-29T10:00:00Z",
    };
    const moved = shiftDates(value, OFFSET);
    expect(moved).toEqual({
      departureDate: "2026-09-29",
      departureTime: "18:05:00",
      stay: { checkInDate: "2026-09-30", birthDate: "2025-06-15" },
      createdAt: "2026-07-29T10:00:00Z",
    });
    expect(shiftDates(moved, -OFFSET)).toEqual(value);
  });

  it("keeps every gap between travel dates in a recorded shop", () => {
    const body = JSON.parse(loadRole("seedOffer").response.body);
    const before = travelDates(body);
    const after = travelDates(shiftDates(body, OFFSET));
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before.map((d) => addDays(d, OFFSET)));
  });
});

describe("match", () => {
  it.each(index.pairs.map((p) => [p.fullPath, p.digest]))("matches %s %s to itself exactly", (path, digest) => {
    const { pair, kind } = match(path, loadPair(path, digest).request);
    expect(kind).toBe("exact");
    expect(pair.meta.requestDigest).toBe(digest);
  });

  it("falls back to the closest recording on the same path, the same way every time", () => {
    const request = { ...(loadRole("sameDayShop").request as object), pointOfSale: "elsewhere" };
    const first = match("/v1/offers/flightShop", request);
    expect(first.kind).toBe("fallback");
    expect(match("/v1/offers/flightShop", request).pair.meta.requestDigest).toBe(first.pair.meta.requestDigest);
  });

  it("misses, naming the path, when no recording exists for it (S10)", () => {
    expect(() => match("/v1/trip/orders/exchangeTickets", {})).toThrow(ReplayMiss);
    expect(() => match("/v1/trip/orders/exchangeTickets", {})).toThrow("/v1/trip/orders/exchangeTickets");
  });

  it("misses when a request shares nothing with any recording on the path", () => {
    expect(() => match("/v1/offers/flightShop", { unrelated: true })).toThrow(ReplayMiss);
  });
});

describe("replay on demo day", () => {
  it("puts the recordings' departure on the demo departure", () => {
    expect(OFFSET).toBe(61);
    expect(dayOffset(DEMO)).toBe(OFFSET);
  });

  it.each([
    ["sameDayShop", DEMO],
    ["nextMorningShop", addDays(DEMO, 1)],
  ] as const)("serves the %s recording exactly for a %s departure (S2, S4)", (role, date) => {
    const request = demoRequest(role);
    expect(JSON.stringify(request)).toContain(date);
    const res = replay(casting.roles[role].path, request, DEMO);
    expect(res.kind).toBe("exact");
    expect(res.digest).toBe(casting.roles[role].digest);
  });

  it("returns flights dated on the demo calendar", () => {
    const res = replay(casting.roles.nextMorningShop.path, demoRequest("nextMorningShop"), DEMO);
    const dates = travelDates(res.body);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => d >= addDays(DEMO, 1))).toBe(true);
  });

  it("serves the crib-hotel rates exactly with hotel dates moved (S4)", () => {
    const request = demoRequest("cribRates");
    expect(JSON.stringify(request)).toContain(`"checkInDate":"${DEMO}"`);
    const res = replay(casting.roles.cribRates.path, request, DEMO);
    expect(res.kind).toBe("exact");
    expect(JSON.stringify(res.body)).toContain("401.79");
  });

  it("serves every cast rebook step, pinned, in order (S6)", () => {
    const served = casting.rebook.steps.map((s) => replayPinned(s, DEMO));
    expect(served.map((r) => r.digest)).toEqual(casting.rebook.steps.map((s) => s.digest));
    expect(served.every((r) => r.kind === "pinned" && r.ok)).toBe(true);
    expect(replayPinned(casting.rebook.failedFulfill, DEMO).ok).toBe(false);
  });
});
