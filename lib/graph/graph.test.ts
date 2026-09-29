import { describe, expect, it } from "vitest";

import { detect } from "@/lib/domain/detect";
import { buildSeedTrip } from "@/lib/domain/seed";
import { weatherAlert } from "@/lib/domain/supplier";
import type { RepairCase } from "@/lib/domain/types";

import { buildGraph } from "./build";
import { ENTITLEMENT_UNUSED, LEARNER_OFF, supportsFamilyFirst, walk } from "./walk";

const trip = buildSeedTrip("2026-09-29");
const repairCase = detect(trip, weatherAlert("ORD")).repairCase!;
const said = (text: string, childName?: string) => ({ facts: [{ kind: "travels_with_infant" as const, text, childName }] });
const learned = (text: string, childName?: string) => ({
  facts: [{ kind: "learned_choice" as const, text, chose: "overnight-at-hub" as const, over: "later-connection" as const, childName }],
});
const rel = (g: ReturnType<typeof buildGraph>, r: string) => g.edges.filter((e) => e.rel === r).map((e) => `${e.from} -> ${e.to}`);

describe("context graph: the data model", () => {
  const g = buildGraph({ trip, repairCase });

  it("has the standing hierarchy: Trip owns Booking, Booking contains every segment", () => {
    expect(rel(g, "OWNS")).toEqual(["trip:trip-1 -> booking:QKRVTB", "trip:trip-1 -> party:trip-1"]);
    expect(rel(g, "CONTAINS_SEGMENT")).toEqual([
      "booking:QKRVTB -> segment:AA3321:2026-09-29",
      "booking:QKRVTB -> segment:WS1611:2026-09-29",
      "booking:QKRVTB -> segment:AA1633:2026-10-04",
      "booking:QKRVTB -> segment:AA4371:2026-10-04",
    ]);
    expect(g.nodes.filter((n) => n.affected).map((n) => n.id)).toEqual(["segment:WS1611:2026-09-29"]);
  });

  it("has a Party whose members are the travelers", () => {
    expect(rel(g, "MEMBER")).toEqual(["party:trip-1 -> traveler:maya", "party:trip-1 -> traveler:sam", "party:trip-1 -> traveler:nora"]);
    expect(g.nodes.find((n) => n.kind === "party")).toMatchObject({ label: "Party of 3", detail: "2 adults · 1 infant" });
  });

  it("attaches the one-shot event by its reference keys, not by object", () => {
    const event = g.nodes.find((n) => n.kind === "event")!;
    expect(event.keys).toEqual({ booking_locator: "QKRVTB", affected_item_id: "WS1611:2026-09-29" });
    expect(rel(g, "AFFECTS")).toEqual(["event:case-trip-1-ORD -> segment:WS1611:2026-09-29"]);
  });

  it("fetches preferences and entitlements from the profile store by traveler id", () => {
    expect(rel(g, "HAS_PREFERENCE")).toEqual(["traveler:maya -> preference:maya:0"]);
    expect(rel(g, "HAS_ENTITLEMENT")).toEqual(["traveler:maya -> entitlement:maya:0"]);
    expect(g.nodes.find((n) => n.id === "entitlement:maya:0")?.source).toEqual({ kind: "profile", ref: "traveler_id maya" });
  });

  it("derives requirements from the infant member, never stores them", () => {
    expect(rel(g, "REQUIRES")).toEqual(["traveler:nora -> requirement:nora:bassinet", "traveler:nora -> requirement:nora:crib"]);
    expect(g.nodes.find((n) => n.kind === "requirement")?.source.kind).toBe("derived");
  });

  it("ties what the traveler said to the person it is about", () => {
    const withSaid = buildGraph({ trip, repairCase, memory: said("we're flying with our baby, Nora", "Nora") });
    expect(rel(withSaid, "SAID_ABOUT")).toEqual(["statement:0 -> traveler:nora"]);
  });

  it("writes the refund decision back, tied to the infant and to the choice that justified it (item 5)", () => {
    const g2 = buildGraph({
      trip,
      repairCase,
      memory: {
        facts: [
          ...learned("Nora needs a real night's sleep").facts,
          { kind: "refund_decision" as const, text: "Nora needs a real night's sleep", hotel: "Bow River Lodge", amountCents: 52000, route: "email" as const },
        ],
      },
    });
    expect(rel(g2, "SAID_ABOUT")).toEqual(["learned:0 -> traveler:nora", "decision:1 -> traveler:nora"]);
    expect(rel(g2, "BECAUSE")).toEqual(["decision:1 -> learned:0"]);
    expect(g2.nodes.find((n) => n.id === "decision:1")).toMatchObject({
      label: "Asked Bow River Lodge for $520.00 back",
      detail: "because “Nora needs a real night's sleep”",
    });
  });

  it("ties a choice the traveler made for the infant to her, as a learned node (L2)", () => {
    const g2 = buildGraph({ trip, repairCase, memory: learned("Nora needs a real night's sleep") });
    expect(rel(g2, "SAID_ABOUT")).toEqual(["learned:0 -> traveler:nora"]);
    expect(g2.nodes.find((n) => n.id === "learned:0")).toMatchObject({
      kind: "learned",
      label: "Chose the overnight: “Nora needs a real night's sleep”",
      source: { kind: "conversation", ref: "chose overnight-at-hub over later-connection: Nora needs a real night's sleep" },
    });
  });
});

describe("walk", () => {
  it("has nothing to walk before there is an event", () => {
    expect(walk(buildGraph({ trip })).coverage.status).toBe("degraded");
  });

  it("goes event → segment → booking → trip → party → Nora, each fact with its path (G1)", () => {
    const w = walk(buildGraph({ trip, repairCase, memory: learned("a real night's sleep") }), { everyOptionNonStop: true, learner: true });
    expect(w.coverage).toEqual({ status: "complete" });
    expect(w.reached.slice(0, 5)).toEqual([
      "event:case-trip-1-ORD",
      "segment:WS1611:2026-09-29",
      "booking:QKRVTB",
      "trip:trip-1",
      "party:trip-1",
    ]);
    const nora = w.applicable.find((f) => f.kind === "traveler")!;
    expect(nora.path).toEqual(["Storm at ORD", "WS 1611 ORD→YYC", "Booking QKRVTB", "Banff trip", "Party of 3", "Nora (infant)"]);
    expect(w.applicable.find((f) => f.kind === "learned")?.path.at(-2)).toBe("Nora (infant)");
    expect(supportsFamilyFirst(w)).toBe(true);
  });

  it("reaches the profile facts but uses neither (G2)", () => {
    const w = walk(buildGraph({ trip, repairCase, memory: learned("a real night's sleep") }), { everyOptionNonStop: true, learner: true });
    expect(w.unused).toEqual([
      expect.objectContaining({ kind: "preference", label: "Direct flights only", reason: expect.stringMatching(/met by every option/) }),
      expect.objectContaining({ kind: "entitlement", label: "Gold member", reason: ENTITLEMENT_UNUSED }),
    ]);
  });

  it("degrades when the event's keys resolve to nothing on the booking", () => {
    const stray: RepairCase = { ...repairCase, affectedItemId: "XX999:2026-09-29" };
    const w = walk(buildGraph({ trip, repairCase: stray, memory: learned("a real night's sleep") }));
    expect(w.coverage).toMatchObject({ status: "degraded", reason: expect.stringMatching(/match no booked segment/) });
    expect(supportsFamilyFirst(w)).toBe(false);
  });

  it("reports a profile store that can't answer as degraded data, not a default", () => {
    const failing = () => {
      throw new Error("profile service timeout");
    };
    const w = walk(buildGraph({ trip, repairCase, memory: learned("a real night's sleep"), profiles: failing }));
    expect(w.coverage).toMatchObject({ status: "degraded", reason: expect.stringMatching(/profile for Maya could not be fetched/) });
    expect(supportsFamilyFirst(w)).toBe(false);
  });

  it("does not support family-first ranking until something has been learned from a choice (L1)", () => {
    expect(supportsFamilyFirst(walk(buildGraph({ trip, repairCase })))).toBe(false);
    expect(supportsFamilyFirst(walk(buildGraph({ trip, repairCase, memory: said("we have a baby") })))).toBe(false);
    expect(supportsFamilyFirst(walk(buildGraph({ trip, repairCase, memory: learned("a real night's sleep") }), { learner: true }))).toBe(true);
  });

  it("with the learner off, keeps what was learned on the graph but doesn't use it (Scenario 2 vs 3)", () => {
    const off = walk(buildGraph({ trip, repairCase, memory: learned("a real night's sleep") }), { learner: false });
    expect(supportsFamilyFirst(off)).toBe(false);
    expect(off.unused).toContainEqual(expect.objectContaining({ kind: "learned", reason: LEARNER_OFF }));
    expect(off.coverage).toEqual({ status: "complete" });
  });

  it("degrades when it can't tell who a statement is about (G4)", () => {
    const w = walk(buildGraph({ trip, repairCase, memory: said("we're travelling with our baby Theo", "Theo") }));
    expect(w.coverage).toEqual({ status: "degraded", reason: "couldn't tell who “we're travelling with our baby Theo” is about" });
  });
});
