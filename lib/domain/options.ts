import { addDays } from "@/lib/replay/shift";

import { MINIMUM_CONNECT_MINUTES, THROUGH_SERVICE_FACTOR } from "./constants";
import { shopFlights, type SupplierCall } from "./supplier";
import { addMinutes, minutesBetween } from "./time";
import type { Offer, RepairCase, RepairOption, Segment, Trip } from "./types";

// The two ways out of a broken connection, each built from the booked first
// leg plus a real onward flight the shop returned. The return is never
// touched: a late connection on the way out is no reason to move the flight
// home. Options are unpriced here except for the fare (the carrier moves them
// at no fare difference); the overnight's room is priced by rank.ts.

const at = (date: string, time: string) => `${date}T${time}`;
const flightKey = (s: Segment) => `${s.carrier}${s.number}`;

/** Non-stop hub -> destination flights on `day`, earliest first, one per flight number. */
export function onwardNonStops(offers: Offer[], hub: string, dest: string, day: string): Segment[] {
  const legs = offers
    .filter((o) => o.segments.length === 1)
    .map((o) => o.segments[0])
    .filter((s) => s.from === hub && s.to === dest && s.departDate === day)
    .sort((a, b) => a.departTime.localeCompare(b.departTime));

  const seen = new Set<string>();
  const unique = legs.filter((s) => !seen.has(flightKey(s)) && seen.add(flightKey(s)));

  // One flight number can still stop on the way: anything much slower than the
  // quickest flight on the route is a through-service, not a non-stop.
  const elapsed = (s: Segment) => minutesBetween(at(s.departDate, s.departTime), at(s.arriveDate, s.arriveTime));
  const quickest = Math.min(...unique.map(elapsed).filter((m) => m > 0));
  const kept = unique.filter((s) => !(elapsed(s) > quickest * THROUGH_SERVICE_FACTOR));
  return kept.length ? kept : unique;
}

function lostDayNote(trip: Trip): string {
  return `you reach ${trip.hotel.city} a day late, so one night at the ${trip.hotel.name} goes unused`;
}

export function buildOptions(
  trip: Trip,
  repairCase: RepairCase,
  depart?: string,
): { options: RepairOption[]; calls: SupplierCall[] } {
  const { hub, inbound, onward } = repairCase;
  const dest = onward.to;
  const day = onward.departDate;
  const bookedArrival = at(onward.arriveDate, onward.arriveTime);
  const readyAt = addMinutes(at(inbound.arriveDate, inbound.arriveTime), repairCase.delayMinutes);

  // By value, not identity: the case and the trip may each have come back from storage.
  const onwardIndex = trip.segments.findIndex(
    (s) => flightKey(s) === flightKey(onward) && s.departDate === onward.departDate,
  );
  if (onwardIndex < 0) throw new Error("the broken leg is not on the booked trip");
  const withOnward = (now: Segment) => trip.segments.map((s, i) => (i === onwardIndex ? now : s));

  const options: RepairOption[] = [];
  const calls: SupplierCall[] = [];

  const sameDay = shopFlights([{ from: hub, to: dest, date: day }], trip.travelers, depart);
  calls.push(sameDay.call);
  const later = onwardNonStops(sameDay.offers, hub, dest, day).find(
    (s) => minutesBetween(readyAt, at(s.departDate, s.departTime)) >= MINIMUM_CONNECT_MINUTES,
  );
  if (later) {
    options.push({
      id: "later-connection",
      title: `Later ${hub} connection, same day`,
      segments: withOnward(later),
      changed: [{ was: onward, now: later }],
      priceDelta: 0,
      arrivalDeltaMinutes: minutesBetween(bookedArrival, at(later.arriveDate, later.arriveTime)),
      familyFit: 0.4,
      familyCapable: false,
      arrivesOn: later.arriveDate,
      rationale: [
        "no fare difference to move onto this flight",
        "you still get in tonight, and you keep the rest of the trip",
      ],
      accommodations: [],
      tradeoff: "",
    });
  }

  const tomorrow = addDays(day, 1);
  const nextDay = shopFlights([{ from: hub, to: dest, date: tomorrow }], trip.travelers, depart);
  calls.push(nextDay.call);
  const morning = onwardNonStops(nextDay.offers, hub, dest, tomorrow)[0];
  if (morning) {
    options.push({
      id: "overnight-at-hub",
      title: `Overnight at ${hub}, first flight out tomorrow`,
      segments: withOnward(morning),
      changed: [{ was: onward, now: morning }],
      priceDelta: 0,
      // Until a room is quoted this option must not read as free.
      roomUnpriced: true,
      arrivalDeltaMinutes: minutesBetween(bookedArrival, at(morning.arriveDate, morning.arriveTime)),
      familyFit: 0.55,
      familyCapable: true,
      overnightAt: hub,
      arrivesOn: morning.arriveDate,
      rationale: [
        "no fare difference on the flight itself",
        "no sprint for the connection: you land, you stop, you fly out rested",
      ],
      accommodations: [],
      tradeoff: lostDayNote(trip),
    });
  }

  return { options, calls };
}
