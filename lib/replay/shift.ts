// A recording is frozen on its capture dates; the demo runs on others. Every
// travel date moves by ONE whole-day offset (demo departure minus captured
// departure), in both directions: outgoing requests shift back onto the
// capture dates so they match a recording exactly, and the recorded response
// shifts forward onto the demo dates. Times are untouched, so connection gaps,
// overnights and trip lengths survive.
//
// Only travel dates move. Birth dates, ticketing deadlines and record
// timestamps are facts about people or the recording, not the itinerary.

export const TRAVEL_DATE_KEYS = new Set([
  "departureDate",
  "arrivalDate",
  "checkInDate",
  "checkOutDate",
  "startDate",
  "endDate",
]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const toUtc = (date: string) => Date.parse(`${date}T00:00:00Z`);

export function addDays(date: string, days: number): string {
  return new Date(toUtc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** A copy of `value` with every travel date moved by `days`. */
export function shiftDates<T>(value: T, days: number): T {
  if (days === 0) return value;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [
        k,
        TRAVEL_DATE_KEYS.has(k) && typeof v === "string" && DATE.test(v) ? addDays(v, days) : walk(v),
      ]),
    );
  };
  return walk(value) as T;
}
