// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { detect } from "@/lib/domain/detect";
import { buildOptions } from "@/lib/domain/options";
import { rank } from "@/lib/domain/rank";
import { buildSeedTrip } from "@/lib/domain/seed";
import { weatherAlert } from "@/lib/domain/supplier";
import type { ContextMode, TravelerMemory } from "@/lib/domain/types";
import { contextView } from "@/lib/graph/view";
import type { TripState } from "@/lib/state";

import { ContextGraph } from "./ContextGraph";

const DEMO = "2026-09-29";
const trip = buildSeedTrip(DEMO);
const repairCase = detect(trip, weatherAlert("ORD")).repairCase!;
const LEARNED_FACT = {
  kind: "learned_choice" as const,
  text: "Nora needs a real night's sleep",
  chose: "overnight-at-hub" as const,
  over: "later-connection" as const,
};
const memory: TravelerMemory = { facts: [LEARNED_FACT] };

function stateFor(mode: ContextMode, facts = memory) {
  const { options } = buildOptions(trip, repairCase, DEMO);
  const ranked = rank(options, { trip, repairCase, memory: facts, depart: DEMO, mode, learner: true });
  const state: TripState = {
    trip,
    repairCase,
    options: ranked.ranked,
    learnerApplied: ranked.learnerApplied,
    contextMode: mode,
    learner: true,
    approvals: {},
    ledger: [],
  };
  return { context: contextView(state, facts), options: state.options };
}

afterEach(cleanup);

describe("ContextGraph", () => {
  it("draws the walk from the storm to the family, and what informed the recommendation (G1)", () => {
    const { container } = render(<ContextGraph {...stateFor("context")} onMode={() => {}} />);
    const ids = [...container.querySelectorAll("[data-node]")].map((n) => n.getAttribute("data-node"));
    expect(ids).toEqual(expect.arrayContaining(["event:case-trip-1-ORD", "booking:QKRVTB", "traveler:nora", "learned:0", "entitlement:maya:0", "preference:maya:0", "party:trip-1", "recommendation"]));
    expect(container.querySelectorAll('[data-rel="INFORMED"]').length).toBeGreaterThan(1);

    const inspector = screen.getByTestId("inspector");
    expect(inspector.textContent).toContain("Context-aware ranking");
    expect(within(inspector).getByTestId("lens-recommendation").textContent).toBe("Overnight at ORD, first flight out tomorrow");
    expect(inspector.textContent).toContain("Storm at ORD → WS 1611 ORD→YYC → Booking QKRVTB → Banff trip → Party of 3 → Nora (infant)");
  });

  it("lists the loyalty tier as known but not used (G2)", () => {
    render(<ContextGraph {...stateFor("context")} onMode={() => {}} />);
    expect(screen.getByTestId("unused").textContent).toMatch(/Gold member.*cash-only/);
  });

  it("in booking-only mode recommends the same-day option and cites no context (G3)", () => {
    const { container } = render(<ContextGraph {...stateFor("booking")} onMode={() => {}} />);
    const inspector = screen.getByTestId("inspector");
    expect(inspector.textContent).toContain("Booking-only ranking");
    expect(within(inspector).getByTestId("lens-recommendation").textContent).toBe("Later ORD connection, same day");
    expect(inspector.textContent).toContain("No traveler context was used.");
    expect(inspector.textContent).not.toContain("→ Nora");
    expect(container.querySelectorAll('[data-rel="INFORMED"]')).toHaveLength(1);
  });

  it("says when coverage is degraded (G4)", () => {
    const unclear: TravelerMemory = { facts: [{ ...LEARNED_FACT, text: "Theo sleeps badly", childName: "Theo" }] };
    render(<ContextGraph {...stateFor("context", unclear)} onMode={() => {}} />);
    expect(screen.getByTestId("inspector").textContent).toMatch(/coverage degraded · couldn't tell who/);
  });

  it("hands the lens choice back", () => {
    const onMode = vi.fn();
    render(<ContextGraph {...stateFor("context")} onMode={onMode} />);
    fireEvent.click(screen.getByText("Booking only"));
    expect(onMode).toHaveBeenCalledWith("booking");
  });
});
