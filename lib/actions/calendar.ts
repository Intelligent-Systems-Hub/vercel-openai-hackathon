import type { Segment, Trip } from "@/lib/domain/types";

// An .ics file for the rebooked trip's flights. Flight times are the airports'
// local times, which is how a traveler reads them, so they are written as
// floating times (no zone): a calendar shows 08:40 wherever the phone is.

const CRLF = "\r\n";

const stamp = (date: string, time: string) => `${date.replaceAll("-", "")}T${time.replace(":", "")}00`;

/** Escape text per RFC 5545. */
const text = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

function event(s: Segment, trip: Trip, now: string): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${trip.bookingCode}-${s.carrier}${s.number}-${s.departDate}@trip-repair-agent`,
    `DTSTAMP:${now}`,
    `DTSTART:${stamp(s.departDate, s.departTime)}`,
    `DTEND:${stamp(s.arriveDate, s.arriveTime)}`,
    `SUMMARY:${text(`${s.carrier} ${s.number} ${s.from} → ${s.to}`)}`,
    `DESCRIPTION:${text(`Booking ${trip.bookingCode}`)}`,
    `LOCATION:${text(s.from)}`,
    "END:VEVENT",
  ];
}

export function tripCalendar(trip: Trip, now = new Date()): string {
  const dtstamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Trip Repair Agent//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...trip.segments.flatMap((s) => event(s, trip, dtstamp)),
    "END:VCALENDAR",
  ];
  return lines.join(CRLF) + CRLF;
}

/** The plain-text itinerary used in the email and the SMS. */
export function itineraryText(trip: Trip): { subject: string; text: string } {
  const legs = trip.segments.map(
    (s) => `${s.carrier} ${s.number}  ${s.from}→${s.to}  ${s.departDate} ${s.departTime}–${s.arriveTime}`,
  );
  return {
    subject: `Your trip is rebooked: ${trip.bookingCode}`,
    text: [`Your trip has been rebooked. Booking ${trip.bookingCode}.`, "", ...legs].join("\n"),
  };
}
