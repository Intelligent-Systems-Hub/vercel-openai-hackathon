import type { Segment } from "@/lib/domain/types";

import styles from "./cards.module.css";
import { Leg } from "./Legs";

export type RebookOutput = {
  outcome: "rebooked" | "failed";
  oldBooking: "intact" | "cancelled" | "retained";
  newBookingCode?: string;
  error?: string;
  steps: { step: string; booking: string; ok: boolean; detail: string }[];
};

const OLD_BOOKING: Record<RebookOutput["oldBooking"], string> = {
  cancelled: "Your old booking was released after the new tickets were issued.",
  retained: "Your old booking is still held; we'll release it once the airline confirms.",
  intact: "Your original booking is untouched.",
};

/** The result of the rebook, rewritten once the new tickets exist. */
export function BookingCard({ result, newLeg }: { result: RebookOutput; newLeg?: Segment }) {
  const ok = result.outcome === "rebooked";
  return (
    <section className={styles.card} aria-label="Booking update">
      <div className={styles.eyebrow}>
        <span>{ok ? "Rebooked" : "Rebooking stopped"}</span>
        {result.newBookingCode && ok && <span className={styles.code}>{result.newBookingCode}</span>}
      </div>
      {ok ? (
        <div className={styles.ok}>You&apos;re booked on the new flight.</div>
      ) : (
        <div className={styles.tradeoff}>{result.error ?? "The rebooking could not be completed."}</div>
      )}
      {ok && newLeg && <Leg segment={newLeg} />}
      <div className={styles.muted}>{OLD_BOOKING[result.oldBooking]}</div>
    </section>
  );
}
