import { afterEach, describe, expect, it, vi } from "vitest";

import { casting } from "@/lib/fixtures";
import { replayPinned } from "@/lib/replay";

import { detect } from "./detect";
import { execute } from "./execute";
import { checkGate, type Approval } from "./gate";
import { buildOptions } from "./options";
import { rank } from "./rank";
import { buildSeedTrip } from "./seed";
import { assertSandbox, NotSandboxError, settle, type LedgerEntry } from "./settle";
import { weatherAlert } from "./supplier";
import type { RepairOption, TravelerMemory, Trip } from "./types";

const DEMO = "2026-09-29";
const trip = buildSeedTrip(DEMO);
const repairCase = detect(trip, weatherAlert("ORD")).repairCase!;
const { options, calls: shopCalls } = buildOptions(trip, repairCase, DEMO);

/** What the agent learned when the traveler chose the overnight over its recommendation. */
const LEARNED_FACT = {
  kind: "learned_choice" as const,
  text: "Nora needs a real night's sleep",
  chose: "overnight-at-hub" as const,
  over: "later-connection" as const,
};
const remembered: TravelerMemory = { facts: [LEARNED_FACT] };
const flightOf = (o: RepairOption) => `${o.changed[0].now.carrier}${o.changed[0].now.number}`;

describe("options", () => {
  it("offers a later same-day connection and an overnight, from exact recordings", () => {
    expect(options.map((o) => o.id)).toEqual(["later-connection", "overnight-at-hub"]);
    expect(shopCalls.every((c) => c.kind === "exact")).toBe(true);
  });

  it("moves only the onward leg, keeping the first leg and the return", () => {
    for (const o of options) {
      expect(o.segments[0]).toBe(trip.segments[0]);
      expect(o.segments.slice(2)).toEqual(trip.segments.slice(2));
      expect(o.changed).toHaveLength(1);
      expect(o.changed[0].was).toBe(trip.segments[1]);
    }
  });

  it("picks the first non-stop the family can still make, and the first one out next morning", () => {
    const [later, overnight] = options;
    expect(flightOf(later)).toBe("UA1156"); // 19:45: the delayed inbound lands 17:23, +45 = 18:08
    expect(later.arrivalDeltaMinutes).toBe(138); // 22:37 vs the booked 20:19
    expect(flightOf(overnight)).toBe("UA764"); // 08:40; the 07:00 through-service is skipped
    expect(overnight.arrivalDeltaMinutes).toBe(913);
    expect(overnight.roomUnpriced).toBe(true);
  });
});

describe("rank", () => {
  it("without memory, gets them moving soonest: the same-day connection leads (S2)", () => {
    const { ranked, learnerApplied } = rank(options, { trip, repairCase, depart: DEMO });
    expect(learnerApplied).toBe(false);
    expect(ranked.map((o) => o.id)).toEqual(["later-connection", "overnight-at-hub"]);
    expect(ranked[0].reasoning).toBeUndefined();
  });

  it("prices the overnight's room with the booking alone too, without talking about cribs", () => {
    const overnight = rank(options, { trip, repairCase, depart: DEMO, mode: "booking" }).ranked[1];
    expect(overnight.priceDelta).toBe(401.79);
    expect(overnight.roomUnpriced).toBeUndefined();
    expect(overnight.hotel?.name).toMatch(/Sheraton/);
    expect(overnight.accommodations).toEqual([]);
  });

  it("with context on, shows the infant layer on the overnight without reordering (item 6)", () => {
    const { ranked, learnerApplied } = rank(options, { trip, repairCase, depart: DEMO });
    expect(learnerApplied).toBe(false);
    expect(ranked.map((o) => o.id)).toEqual(["later-connection", "overnight-at-hub"]);
    expect(ranked[1].accommodations).toEqual(["bassinet row", "crib at no charge"]);
    expect(ranked[1].reasoning).toBeUndefined();
    expect(ranked[0].accommodations).toEqual([]);
  });

  it("with the learner off, a learned choice doesn't reorder (Scenario 2 vs 3)", () => {
    const off = rank(options, { trip, repairCase, memory: remembered, depart: DEMO });
    expect(off.learnerApplied).toBe(false);
    expect(off.ranked[0].id).toBe("later-connection");
  });

  it("being told about the infant is not enough to cost the family a day (L1)", () => {
    const told: TravelerMemory = { facts: [{ kind: "travels_with_infant", text: "we're flying with the baby" }] };
    const { ranked, learnerApplied, walk } = rank(options, { trip, repairCase, memory: told, depart: DEMO });
    expect(learnerApplied).toBe(false);
    expect(ranked[0].id).toBe("later-connection");
    expect(walk.coverage).toEqual({ status: "complete" });
  });

  it("with a choice learned, leads with the overnight and a free crib, and says why (L3, S4)", () => {
    const { ranked, learnerApplied, calls } = rank(options, { trip, repairCase, memory: remembered, depart: DEMO, learner: true });
    expect(learnerApplied).toBe(true);
    const [top] = ranked;
    expect(top.id).toBe("overnight-at-hub");
    expect(top.priceDelta).toBe(401.79);
    expect(top.familyFit).toBe(0.95);
    expect(top.accommodations).toEqual(["bassinet row", "crib at no charge"]);
    expect(top.reasoning?.headline).toBe("Last time you chose a night's stop for Nora");
    expect(top.reasoning?.because.map((b) => b.text)).toContain("last time you chose the overnight: “Nora needs a real night's sleep”");
    expect(top.reasoning?.because.map((b) => b.text)).toContain("7 minutes to change planes, with a stroller");
    expect(top.reasoning?.tradeoff).toMatch(/a day late/);
    expect(ranked[1].reasoning).toBeUndefined();
    expect(calls.every((c) => c.kind === "exact")).toBe(true);
  });

  it("cites a context-graph path for every reason (G1)", () => {
    const [top] = rank(options, { trip, repairCase, memory: remembered, depart: DEMO, learner: true }).ranked;
    for (const reason of top.reasoning!.because) {
      expect(reason.path?.[0], reason.text).toBe("Storm at ORD");
    }
    expect(top.reasoning!.because[0].path).toEqual(["Storm at ORD", "WS 1611 ORD→YYC", "Booking QKRVTB", "Banff trip", "Party of 3", "Nora (infant)"]);
  });

  it("in booking-only mode ranks without traveler context, at the same prices (G3)", () => {
    const withContext = rank(options, { trip, repairCase, memory: remembered, depart: DEMO, learner: true });
    const bookingOnly = rank(options, { trip, repairCase, memory: remembered, depart: DEMO, learner: true, mode: "booking" });
    expect(bookingOnly.learnerApplied).toBe(false);
    expect(bookingOnly.ranked[0].id).toBe("later-connection");
    expect(bookingOnly.ranked.some((o) => o.reasoning || o.familyAware)).toBe(false);
    const price = (r: typeof withContext) => Object.fromEntries(r.ranked.map((o) => [o.id, o.priceDelta]));
    expect(price(bookingOnly)).toEqual(price(withContext));
  });

  it("never lets profile facts (preference, entitlement) change the ranking (G2)", () => {
    const a = rank(options, { trip, repairCase, memory: remembered, depart: DEMO, learner: true }).ranked;
    const b = rank(options, { trip, repairCase, memory: remembered, depart: DEMO, learner: true, profiles: () => undefined }).ranked;
    expect(a.map((o) => [o.id, o.priceDelta])).toEqual(b.map((o) => [o.id, o.priceDelta]));
  });

  it("falls back to the baseline when it can't tell who a statement is about (G4)", () => {
    const unclear: TravelerMemory = { facts: [{ ...LEARNED_FACT, text: "Theo sleeps badly", childName: "Theo" }] };
    const { ranked, learnerApplied, walk } = rank(options, { trip, repairCase, memory: unclear, depart: DEMO });
    expect(learnerApplied).toBe(false);
    expect(ranked[0].id).toBe("later-connection");
    expect(walk.coverage).toMatchObject({ status: "degraded" });
  });

  it("does not re-rank on a remembered infant when no child is on the booking", () => {
    const adultsOnly: Trip = { ...trip, travelers: trip.travelers.filter((t) => t.type === "adult") };
    const { ranked, learnerApplied } = rank(options, { trip: adultsOnly, repairCase, memory: remembered, depart: DEMO, learner: true });
    expect(learnerApplied).toBe(false);
    expect(ranked[0].id).toBe("later-connection");
  });
});

describe("gate (S5)", () => {
  const [later, overnight] = rank(options, { trip, repairCase, memory: remembered, depart: DEMO, learner: true }).ranked.sort(
    (a, b) => a.id.localeCompare(b.id),
  );
  const approval = (over: Partial<Approval> = {}): Approval => ({
    id: "ap-1",
    optionId: "overnight-at-hub",
    amountCents: 40179,
    nonce: "n",
    used: false,
    ...over,
  });

  it("allows exactly the approved option at the approved price", () => {
    expect(checkGate(overnight, approval())).toEqual({ allowed: true, amountCents: 40179 });
    expect(checkGate(later, approval({ optionId: "later-connection", amountCents: 0 }))).toEqual({
      allowed: true,
      amountCents: 0,
    });
  });

  it.each([
    ["no option", undefined, approval()],
    ["no approval", overnight, undefined],
    ["a used approval", overnight, approval({ used: true })],
    ["an approval for the other option", overnight, approval({ optionId: "later-connection" })],
    ["a different amount", overnight, approval({ amountCents: 100 })],
    ["an unpriced room", { ...overnight, roomUnpriced: true }, approval()],
    ["an unreadable price", { ...overnight, priceDelta: Number.NaN }, approval()],
  ])("refuses %s", (_name, option, ap) => {
    expect(checkGate(option as RepairOption | undefined, ap).allowed).toBe(false);
  });
});

describe("execute (S6)", () => {
  it("creates and tickets the new booking before releasing the old one", () => {
    const result = execute();
    expect(result.outcome).toBe("rebooked");
    expect(result.oldBooking).toBe("cancelled");
    expect(result.steps.map((s) => s.step)).toEqual([
      "getBooking",
      "checkFlightTickets",
      "createBooking",
      "fulfillFlightTickets",
      "cancelBooking",
      "getBooking",
    ]);
    expect(result.steps.map((s) => s.digest)).toEqual(casting.rebook.steps.map((s) => s.digest));
    expect(result.steps.map((s) => s.bookingCode)).toEqual(["QKRVTB", "QKRVTB", "QKRVTA", "QKRVTA", "QKRVTB", "QKRVTA"]);
    expect(result.newBookingCode).toBe("QKRVTA");
    expect(result.tickets).toHaveLength(2);
  });

  it("never cancels the old booking when ticketing fails", () => {
    const result = execute((c) =>
      c.step === "fulfillFlightTickets" ? replayPinned(casting.rebook.failedFulfill) : replayPinned(c),
    );
    expect(result.outcome).toBe("failed");
    expect(result.oldBooking).toBe("intact");
    expect(result.steps.map((s) => s.step)).not.toContain("cancelBooking");
    expect(result.steps.at(-1)).toMatchObject({ step: "fulfillFlightTickets", ok: false });
  });

  it("keeps the old booking when its tickets cannot be voided or refunded", () => {
    const result = execute((c) => {
      const res = replayPinned(c);
      if (c.step !== "checkFlightTickets") return res;
      const body = res.body as { tickets: Record<string, unknown>[] };
      return { ...res, body: { tickets: body.tickets.map((t) => ({ ...t, isVoidable: false, isRefundable: false })) } };
    });
    expect(result.outcome).toBe("rebooked");
    expect(result.oldBooking).toBe("retained");
    expect(result.steps.map((s) => s.step)).not.toContain("cancelBooking");
  });
});

describe("settle (S7)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const approval: Approval = { id: "ap-2", optionId: "overnight-at-hub", amountCents: 40179, nonce: "n", used: false };

  it("charges the approved amount once", () => {
    const ledger: LedgerEntry[] = [];
    const first = settle(approval, ledger);
    expect(first).toMatchObject({ repeated: false, entry: { kind: "charge", amountCents: 40179 } });
    expect(first.entry.captureId).toBeTruthy();
    ledger.push(first.entry);
    expect(settle(approval, ledger)).toEqual({ entry: first.entry, repeated: true });
  });

  it("moves no money for a free option, and refunds a negative difference", () => {
    expect(settle({ ...approval, id: "ap-3", amountCents: 0 }, []).entry.kind).toBe("none");
    expect(settle({ ...approval, id: "ap-4", amountCents: -15000 }, []).entry).toMatchObject({
      kind: "refund",
      amountCents: -15000,
    });
  });

  it("refuses anything but the PayPal sandbox", () => {
    expect(() => assertSandbox("https://api-m.sandbox.paypal.com")).not.toThrow();
    expect(() => assertSandbox("https://api-m.paypal.com")).toThrow(NotSandboxError);
    vi.stubEnv("PAYPAL_BASE_URL", "https://api-m.paypal.com");
    expect(() => settle(approval, [])).toThrow(NotSandboxError);
  });
});
