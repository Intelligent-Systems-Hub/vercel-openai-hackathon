import { MINIMUM_CONNECT_MINUTES, STAGED_DELAY_MINUTES } from "./constants";
import { minutesBetween } from "./time";
import type { RepairCase, Segment, Trip, WeatherAlert } from "./types";

/** A booked item's reference key: carrier, number and date, e.g. "WS1611:2026-09-29". */
export const itemId = (s: Segment) => `${s.carrier}${s.number}:${s.departDate}`;

export type DetectResult =
  | { opened: true; repairCase: RepairCase }
  | { opened: false; reason: string; repairCase?: RepairCase };

/**
 * Does a storm at a connecting airport break this trip's connection?
 *
 * Measured, not asserted: the connection is read off the booked legs, the
 * delay is taken out, and a case opens only if what is left is under the
 * minimum. A second storm for a trip that already has an open case returns
 * that case instead of opening another.
 */
export function detect(
  trip: Trip,
  alert: WeatherAlert | undefined,
  openCase?: RepairCase,
  delayMinutes = STAGED_DELAY_MINUTES,
): DetectResult {
  if (openCase && openCase.tripId === trip.id) {
    return { opened: false, reason: "a repair case is already open for this trip", repairCase: openCase };
  }
  if (!alert || alert.risk.toLowerCase() !== "high") {
    return { opened: false, reason: "no high-risk weather alert" };
  }

  const outbound = trip.segments.slice(0, trip.outboundLegs);
  const at = outbound.findIndex((s, i) => i < outbound.length - 1 && s.to === alert.airport);
  if (at < 0) {
    return { opened: false, reason: `the trip does not connect at ${alert.airport}` };
  }
  const inbound = outbound[at];
  const onward = outbound[at + 1];

  const booked = minutesBetween(
    `${inbound.arriveDate}T${inbound.arriveTime}`,
    `${onward.departDate}T${onward.departTime}`,
  );
  const left = Math.max(booked - delayMinutes, 0);
  if (left >= MINIMUM_CONNECT_MINUTES) {
    return { opened: false, reason: `${left} minutes still leaves a workable connection` };
  }

  return {
    opened: true,
    repairCase: {
      id: `case-${trip.id}-${alert.airport}`,
      tripId: trip.id,
      hub: alert.airport,
      alert,
      delayMinutes,
      bookedConnectionMinutes: booked,
      connectionLeftMinutes: left,
      minimumConnectMinutes: MINIMUM_CONNECT_MINUTES,
      inbound,
      onward,
      bookingLocator: trip.bookingCode,
      affectedItemId: itemId(onward),
    },
  };
}
