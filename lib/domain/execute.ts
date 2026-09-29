import { casting } from "@/lib/fixtures";
import { replayPinned, type Replayed } from "@/lib/replay";

// The rebook, in never-strand order: the NEW booking exists and is ticketed
// before the OLD one is touched, so no failure can leave the family with no
// seat. Any failure before the cancel stops the run with the old booking
// intact; a cancel that fails after ticketing leaves both, flagged.
//
// The recordings behind these steps span two bookings, so each step is served
// from a named recording (fixtures/casting.json): the old booking is read and
// cancelled, the new one created and ticketed.

export type StepName = "getBooking" | "checkFlightTickets" | "createBooking" | "fulfillFlightTickets" | "cancelBooking";

export type StepRecord = {
  step: StepName;
  path: string;
  digest: string;
  ok: boolean;
  status: number;
  /** Which booking the step acted on. */
  bookingCode: string;
  detail: string;
};

export type ExecuteResult = {
  outcome: "rebooked" | "failed";
  /** intact: never touched; cancelled: released after ticketing; retained: kept alongside the new one. */
  oldBooking: "intact" | "cancelled" | "retained";
  newBookingCode?: string;
  tickets: string[];
  steps: StepRecord[];
  error?: string;
};

type Cast = { step: string; path: string; digest: string; booking: string };

/** Serves one step. Tests swap in failures; the app serves the cast recordings. */
export type Serve = (cast: Cast) => Replayed;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

function succeeded(res: Replayed): boolean {
  return res.ok && res.status < 400 && !(Array.isArray(obj(res.body).errors) && (obj(res.body).errors as unknown[]).length);
}

export function execute(serve: Serve = (c) => replayPinned(c)): ExecuteResult {
  const { oldBookingCode, newBookingCode } = casting.rebook;
  const cast = casting.rebook.steps;
  const steps: StepRecord[] = [];

  const run = (i: number, detail: (body: Record<string, unknown>) => string) => {
    const c = cast[i];
    const res = serve(c);
    const ok = succeeded(res);
    steps.push({
      step: c.step as StepName,
      path: c.path,
      digest: res.digest,
      ok,
      status: res.status,
      bookingCode: c.booking === "old" ? oldBookingCode : newBookingCode,
      detail: ok ? detail(obj(res.body)) : "failed",
    });
    return { ok, body: obj(res.body) };
  };
  const stop = (error: string): ExecuteResult => ({ outcome: "failed", oldBooking: "intact", tickets: [], steps, error });

  // 1. Read the old booking.
  if (!run(0, () => "read the booked trip").ok) return stop("could not read the booked trip");

  // 2. Can the old tickets be voided or refunded? If not, the old booking is kept.
  const check = run(1, (b) => {
    const t = (b.tickets as unknown[] | undefined)?.map(obj) ?? [];
    return t.some((x) => x.isVoidable || x.isRefundable) ? "old tickets can be voided" : "old tickets cannot be voided";
  });
  if (!check.ok) return stop("could not check the old tickets");
  const releasable = ((check.body.tickets as unknown[] | undefined) ?? []).map(obj).some((x) => x.isVoidable || x.isRefundable);

  // 3. Create the new booking.
  const created = run(2, (b) => `created ${String(b.confirmationId ?? newBookingCode)}`);
  if (!created.ok) return stop("could not create the new booking");

  // 4. Ticket it. A failure here abandons the unticketed new booking; the old one stands.
  const ticketed = run(3, (b) => `issued ${((b.tickets as unknown[]) ?? []).length} tickets`);
  if (!ticketed.ok) return stop("the new booking could not be ticketed");
  const tickets = ((ticketed.body.tickets as unknown[]) ?? []).map((t) => String(obj(t).number));

  // 5. Only now release the old booking.
  let oldBooking: ExecuteResult["oldBooking"] = "retained";
  if (releasable) {
    const cancelled = run(4, () => "released the old booking");
    oldBooking = cancelled.ok ? "cancelled" : "retained";
  }

  // 6. Re-read the new booking to confirm it.
  run(5, () => "confirmed the new booking");

  return { outcome: "rebooked", oldBooking, newBookingCode, tickets, steps };
}
