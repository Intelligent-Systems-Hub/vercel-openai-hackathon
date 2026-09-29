import { demoDepart } from "@/lib/replay";
import { addDays } from "@/lib/replay/shift";

import { CURRENCY } from "./constants";
import { shopFlights } from "./supplier";
import type { Segment, Traveler, Trip } from "./types";

// The trip the demo opens on: already booked, departing on demo day, routed
// through the hub so a late inbound flight breaks the connection.
//
// Every flight is a row from the recordings, not an invention. The outbound's
// first leg and the return come from the round-trip shop; the onward leg from
// the hub is the same-day hub shop's WestJet non-stop (the carrier interlines
// with American there). The flight price is the round-trip offer's own total
// for the party.

export const BOOKED = {
  origin: "JFK",
  hub: "ORD",
  destination: "YYC",
  nights: 5,
  inbound: { carrier: "AA", number: "3321" },
  onward: { carrier: "WS", number: "1611" },
  returnLegs: [
    { carrier: "AA", number: "1633" },
    { carrier: "AA", number: "4371" },
  ],
} as const;

export const TRAVELERS: Traveler[] = [
  // Maya's preferences and loyalty live in the profile store, not on the
  // booking (fixtures/profiles.json, keyed by traveler id).
  { id: "maya", name: "Maya", type: "adult", age: 36 },
  { id: "sam", name: "Sam", type: "adult", age: 37 },
  { id: "nora", name: "Nora", type: "infant", age: 1 },
];

export const BOOKING_CODE = "QKRVTB";

/**
 * Where the family stays. Trip 1's lodge is fictional (its price and refund
 * policy are demo content); trip 2's hotel and its rate are from the
 * recordings.
 */
export const STAYS = {
  banff: { name: "Bow River Lodge", city: "Banff", nightly: 520 },
  calgary: { name: "Delta Calgary Airport", city: "Calgary", nightly: 213.65 },
} as const;
export type StayKey = keyof typeof STAYS;

const isFlight = (s: Segment, f: { carrier: string; number: string }) =>
  s.carrier === f.carrier && s.number === f.number;

export class SeedError extends Error {}

export function buildSeedTrip(depart = demoDepart(), id = "trip-1", stay: StayKey = "banff"): Trip {
  const ret = addDays(depart, BOOKED.nights);

  const roundTrip = shopFlights(
    [
      { from: BOOKED.origin, to: BOOKED.destination, date: depart },
      { from: BOOKED.destination, to: BOOKED.origin, date: ret },
    ],
    TRAVELERS,
    depart,
  ).offers;
  // The cheapest recorded offer flying our inbound leg and our return.
  const offer = roundTrip
    .filter(
      (o) =>
        o.segments.some((s) => isFlight(s, BOOKED.inbound)) &&
        BOOKED.returnLegs.every((f) => o.segments.some((s) => isFlight(s, f))),
    )
    .sort((a, b) => a.price - b.price)[0];
  if (!offer) throw new SeedError("the round-trip recording has no offer with the booked flights");

  const onward = shopFlights([{ from: BOOKED.hub, to: BOOKED.destination, date: depart }], TRAVELERS, depart)
    .offers.flatMap((o) => o.segments)
    .find((s) => isFlight(s, BOOKED.onward) && s.departDate === depart);
  if (!onward) throw new SeedError("the same-day hub recording has no onward flight to book");

  const inbound = offer.segments.find((s) => isFlight(s, BOOKED.inbound))!;
  const returnLegs = BOOKED.returnLegs.map((f) => offer.segments.find((s) => isFlight(s, f))!);

  return {
    id,
    bookingCode: BOOKING_CODE,
    travelers: TRAVELERS,
    segments: [inbound, onward, ...returnLegs],
    outboundLegs: 2,
    hotel: { ...STAYS[stay], checkin: depart, checkout: ret },
    flightPrice: offer.price,
    currency: CURRENCY,
  };
}
