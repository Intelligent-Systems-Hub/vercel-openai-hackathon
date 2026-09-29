import { formatCents } from "@/lib/approvals";
import type { TripState } from "@/lib/state";

import { itineraryText } from "./calendar";

// What the agent actually did on this trip, read from the trip state rather
// than from anything the model said, so the summary and the receipt card can
// list only actions that happened.

export type ActionTaken = { kind: "rebooked" | "charged" | "refund-email" | "refund-call" | "summary"; text: string };

export function actionsTaken(state: TripState): ActionTaken[] {
  const done: ActionTaken[] = [];
  const rebook = state.rebook;
  if (rebook?.result.outcome === "rebooked") {
    const by = " with your approval";
    const leg = state.trip.segments[1];
    done.push({ kind: "rebooked", text: `Rebooked onto ${leg.carrier} ${leg.number} ${leg.from}→${leg.to} ${leg.departDate} ${leg.departTime}${by}; booking ${state.trip.bookingCode}` });
  }
  for (const entry of state.ledger) {
    if (entry.kind === "charge") done.push({ kind: "charged", text: `Charged ${formatCents(entry.amountCents)} for the room at the connection` });
  }
  const refund = state.refund;
  if (refund) {
    const how =
      refund.route === "email"
        ? refund.sent
          ? `Emailed ${refund.hotel}`
          : `Wrote to ${refund.hotel} (not sent: ${refund.reason})`
        : refund.simulated
          ? `Called ${refund.hotel} (simulated call)`
          : `Called ${refund.hotel}`;
    const heard = refund.outcome ? ` The hotel said: ${refund.outcome}.` : "";
    done.push({ kind: refund.route === "email" ? "refund-email" : "refund-call", text: `${how}: ${refund.framing}${heard}` });
  }
  if (state.summary) {
    done.push({
      kind: "summary",
      text: state.summary.sent ? `Sent this trip summary to ${state.summary.to}` : `Trip summary ready (not sent: ${state.summary.reason})`,
    });
  }
  return done;
}

/** The email to the traveler: the new itinerary, then everything the agent did. */
export function tripSummaryText(state: TripState) {
  const itinerary = itineraryText(state.trip);
  const actions = actionsTaken(state).filter((a) => a.kind !== "summary");
  return {
    subject: `Trip summary: ${state.trip.bookingCode}`,
    text: [
      "Here is what I did about the storm, and your trip as it stands now.",
      "",
      "What I did",
      ...actions.map((a) => `- ${a.text}`),
      "",
      itinerary.text,
    ].join("\n"),
  };
}
