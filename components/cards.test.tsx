// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { detect } from "@/lib/domain/detect";
import { buildOptions } from "@/lib/domain/options";
import { rank } from "@/lib/domain/rank";
import { buildSeedTrip } from "@/lib/domain/seed";
import { weatherAlert } from "@/lib/domain/supplier";

import { AlertCard } from "./AlertCard";
import { ApprovalSheet, parseReason } from "./ApprovalSheet";
import { RichText } from "./RichText";
import { BookingCard } from "./BookingCard";
import { LedgerCard } from "./LedgerCard";
import { TripCard } from "./TripCard";

// Props come from the real domain code over the recordings, so the cards are
// tested against what the app will actually hand them.
const DEMO = "2026-09-29";
const trip = buildSeedTrip(DEMO);
const repairCase = detect(trip, weatherAlert("ORD")).repairCase!;
const { options } = buildOptions(trip, repairCase, DEMO);
const memory = { facts: [{ kind: "learned_choice" as const, text: "Nora needs a real night's sleep", chose: "overnight-at-hub" as const, over: "later-connection" as const }] };
const baseline = rank(options, { trip, repairCase, depart: DEMO }).ranked;
const learned = rank(options, { trip, repairCase, memory, depart: DEMO, learner: true }).ranked;

afterEach(cleanup);

describe("TripCard", () => {
  it("shows the booking, the party and every leg", () => {
    render(<TripCard trip={trip} />);
    expect(screen.getByText("QKRVTB")).toBeTruthy();
    expect(screen.getByText(/Nora \(infant\)/)).toBeTruthy();
    expect(screen.getAllByTestId("leg").map((l) => l.textContent)).toEqual([
      "AA 3321JFK → ORD13:59–15:53",
      "WS 1611ORD → YYC17:30–20:19",
      "AA 1633YYC → ORD07:00–11:35",
      "AA 4371ORD → JFK12:50–16:28",
    ]);
  });
});

describe("AlertCard", () => {
  it("states the measured connection and leads with the same-day option without memory (S2)", () => {
    render(<AlertCard repairCase={repairCase} options={baseline} learnerApplied={false} />);
    expect(screen.getByText(/7 minutes/)).toBeTruthy();
    const cards = screen.getAllByRole("article");
    expect(cards[0].getAttribute("data-testid")).toBe("option-later-connection");
    expect(within(cards[0]).getByText("Recommended")).toBeTruthy();
    expect(within(cards[0]).getByText("Arrives 2h 18m later")).toBeTruthy();
    expect(within(cards[0]).getByText("No extra cost")).toBeTruthy();
    expect(screen.queryByTestId("reasoning")).toBeNull();
  });

  it("leads with the overnight and shows why, with memory (S4)", () => {
    render(<AlertCard repairCase={repairCase} options={learned} learnerApplied />);
    const top = screen.getAllByRole("article")[0];
    expect(top.getAttribute("data-testid")).toBe("option-overnight-at-hub");
    expect(within(top).getByText("$401.79")).toBeTruthy();
    expect(within(top).getByText("crib at no charge")).toBeTruthy();
    expect(within(top).getByTestId("reasoning").textContent).toMatch(/Last time you chose a night's stop for Nora/);
    expect(within(top).getByText(/Trade-off: you reach Banff a day late/)).toBeTruthy();
    expect(screen.getByText("Using what I learned")).toBeTruthy();
  });

  it("shows the replaced leg struck through beside its replacement", () => {
    render(<AlertCard options={learned} learnerApplied />);
    const legs = within(screen.getAllByRole("article")[0]).getAllByTestId("leg");
    expect(legs.map((l) => l.textContent)).toEqual(["WS 1611ORD → YYC17:30–20:19", "UA 764ORD → YYC08:40–11:32"]);
  });

  it("hands the chosen option back", () => {
    const onChoose = vi.fn();
    render(<AlertCard options={learned} learnerApplied onChoose={onChoose} />);
    fireEvent.click(within(screen.getAllByRole("article")[0]).getByText("Choose this"));
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: "overnight-at-hub" }));
  });
});

describe("ApprovalSheet (S5)", () => {
  const reason = "Overnight at ORD, first flight out tomorrow: $401.79";

  it("shows the amount and only approves on an explicit tap", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(<ApprovalSheet reason={reason} onApprove={onApprove} onDecline={onDecline} />);
    expect(screen.getByTestId("approval-amount").textContent).toBe("$401.79");
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Approve $401.79"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("shows what else the same yes covers", () => {
    render(
      <ApprovalSheet
        reason={`${reason} | Also request $520.00 back from Bow River Lodge for the missed night, by email, if the hotel approves`}
        onApprove={() => {}}
        onDecline={() => {}}
      />,
    );
    expect(screen.getByTestId("approval-amount").textContent).toBe("$401.79");
    expect(screen.getByTestId("approval-also").textContent).toMatch(/^Also request \$520.00 back from Bow River Lodge/);
  });

  it("words a refund request as one: nothing charged, the hotel decides (item 4)", () => {
    const onApprove = vi.fn();
    render(<ApprovalSheet reason="Refund request · Bow River Lodge, by email: $520.00" onApprove={onApprove} onDecline={() => {}} />);
    const sheet = screen.getByRole("region", { name: "Confirm refund request" });
    expect(sheet.textContent).toContain("Bow River Lodge, by email");
    expect(sheet.textContent).toContain("Nothing is charged; the hotel decides.");
    fireEvent.click(screen.getByText("Yes, request $520.00"));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("declines without approving", () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(<ApprovalSheet reason={reason} onApprove={onApprove} onDecline={onDecline} />);
    fireEvent.click(screen.getByText("Not now"));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("splits the server's reason into what and how much", () => {
    expect(parseReason(reason)).toEqual({ what: "Overnight at ORD, first flight out tomorrow", amount: "$401.79" });
  });
});

describe("BookingCard and LedgerCard", () => {
  it("shows the new booking and what happened to the old one (S6)", () => {
    render(
      <BookingCard
        result={{ outcome: "rebooked", oldBooking: "cancelled", newBookingCode: "QKRVTA", steps: [] }}
        newLeg={learned[0].changed[0].now}
      />,
    );
    expect(screen.getByText("QKRVTA")).toBeTruthy();
    expect(screen.getByText(/released after the new tickets were issued/)).toBeTruthy();
    expect(screen.getByTestId("leg").textContent).toBe("UA 764ORD → YYC08:40–11:32");
  });

  it("says the original booking stands when rebooking stopped", () => {
    render(<BookingCard result={{ outcome: "failed", oldBooking: "intact", error: "the new booking could not be ticketed", steps: [] }} />);
    expect(screen.getByText("Rebooking stopped")).toBeTruthy();
    expect(screen.getByText(/untouched/)).toBeTruthy();
  });

  it("shows one charge for the approved amount (S7)", () => {
    render(<LedgerCard entry={{ kind: "charge", amountCents: 40179, captureId: "CAP-1" }} />);
    expect(screen.getByTestId("ledger-amount").textContent).toBe("$401.79");
    expect(screen.getByText("Reference CAP-1")).toBeTruthy();
  });
});

describe("RichText", () => {
  it("renders the model's **bold** and `code` as emphasis, and nothing else as markup", () => {
    const { container } = render(<RichText text={"Booked **QKRVTA** for `$401.79`, <b>not html</b>"} />);
    expect(container.querySelector("strong")?.textContent).toBe("QKRVTA");
    expect(container.querySelector("code")?.textContent).toBe("$401.79");
    expect(container.textContent).toBe("Booked QKRVTA for $401.79, <b>not html</b>");
    expect(container.querySelector("b")).toBeNull();
  });
});
