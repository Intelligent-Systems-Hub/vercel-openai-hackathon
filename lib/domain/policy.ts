import type { HotelQuote, Trip } from "./types";

// The destination hotel's refund policy, and the refund the agent may ask
// for when a rebook makes the family miss their first night there.
//
// Two stays, two kinds of policy:
//   - Bow River Lodge (trip 1) is a fictional hotel. Its policy is demo
//     content, written for the demo and labelled as such. It names flight
//     disruption, so it is clear: the agent emails the request.
//   - Delta Calgary Airport (trip 2) uses the cancellation terms from the
//     recorded rate. They say "non-refundable" and nothing about a night
//     missed to a flight disruption, so they are unclear: the agent calls.
//
// Either way the refund is requested, never promised: the hotel decides.

export type Clarity = "clear" | "unclear";

export type HotelPolicy = {
  hotel: string;
  text: string;
  /** Where the words come from. */
  source: string;
  clarity: Clarity;
  /** Why the agent reads it as clear or unclear. */
  reading: string;
};

/** The recorded rate's cancelPenalties for Delta Calgary Airport, verbatim (checked against the fixture in tests). */
export const RECORDED_DELTA_PENALTY = { refundable: false, description: "UP TO 01 DAYS AFTER BOOKING" } as const;

const POLICIES: Record<string, Omit<HotelPolicy, "hotel">> = {
  "Bow River Lodge": {
    text: "Travel disruption: if a documented flight delay or cancellation means you arrive a night late, we refund that night in full. Tell us before your original check-in.",
    source: "demo content (fictional hotel)",
    clarity: "clear",
    reading: "it names flight disruption and refunds the missed night, so a written request is enough",
  },
  "Delta Calgary Airport": {
    text: `Non-refundable · ${RECORDED_DELTA_PENALTY.description.toLowerCase()}`,
    source: "the recorded rate's cancellation terms",
    clarity: "unclear",
    reading: "it says non-refundable but nothing about a night missed to a flight disruption; only the hotel can say, so call",
  },
};

export function hotelPolicy(trip: Trip): HotelPolicy | undefined {
  const found = POLICIES[trip.hotel.name];
  return found && { hotel: trip.hotel.name, ...found };
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type RefundAsk = {
  hotel: string;
  night: string;
  amountCents: number;
  /** What the request would offset: tonight's room at the hub. */
  offsets?: { hotel: string; amountCents: number };
  /** How the agent says it: requested, and what it would mean if approved. */
  framing: string;
};

/** The first night at the destination, which the family now misses, and what it would offset. */
export function refundAsk(trip: Trip, hubRoom?: Pick<HotelQuote, "name" | "total">): RefundAsk {
  const nightly = trip.hotel.nightly;
  const base = `${money(nightly)} requested for the missed night at ${trip.hotel.name}`;
  let framing = `${base}, if the hotel approves.`;
  if (hubRoom) {
    framing =
      nightly >= hubRoom.total
        ? `${base}, which would more than cover tonight's ${money(hubRoom.total)} room if the hotel approves.`
        : `${base}, which would offset ${money(nightly)} of tonight's ${money(hubRoom.total)} room if the hotel approves.`;
  }
  return {
    hotel: trip.hotel.name,
    night: trip.hotel.checkin,
    amountCents: Math.round(nightly * 100),
    offsets: hubRoom && { hotel: hubRoom.name, amountCents: Math.round(hubRoom.total * 100) },
    framing,
  };
}

/** The request as the hotel reads it, composed in code from the booking; the model writes none of it. */
export function refundEmail(trip: Trip, ask: RefundAsk, delay: { hub: string; was: string; now: string; arrives: string }) {
  const names = trip.travelers.map((t) => t.name).join(", ");
  return {
    subject: `Refund request: missed first night, ${names}, check-in ${ask.night}`,
    text: [
      `Hello ${ask.hotel} reservations,`,
      "",
      `I'm writing on behalf of your guests ${names}, due to check in on ${ask.night}.`,
      `A storm at ${delay.hub} broke their connection (${delay.was}). They are rebooked on ${delay.now} and now arrive on ${delay.arrives}, a night late.`,
      "",
      `Under your travel-disruption policy, we request a refund of the first night, ${money(ask.amountCents / 100)}. The rest of the stay is unchanged.`,
      "",
      "Thank you,",
      "Their travel concierge (Trip Repair Agent, a demo)",
    ].join("\n"),
  };
}
