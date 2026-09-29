import type { Trip } from "@/lib/domain/types";
import { day } from "@/lib/ui/format";

import styles from "./cards.module.css";
import { Legs } from "./Legs";

/** The booked trip, as the traveler sees it in their app. */
export function TripCard({ trip }: { trip: Trip }) {
  const out = trip.segments.slice(0, trip.outboundLegs);
  const back = trip.segments.slice(trip.outboundLegs);
  const party = trip.travelers.map((t) => (t.type === "infant" ? `${t.name} (infant)` : t.name)).join(", ");
  return (
    <section className={styles.card} aria-label="Your trip">
      <div className={styles.eyebrow}>
        <span>Your trip</span>
        <span className={styles.code}>{trip.bookingCode}</span>
      </div>
      <h2 className={styles.title}>
        {out[0].from} to {trip.hotel.city}
      </h2>
      <div className={styles.muted}>{party}</div>
      <div className={styles.muted}>Out {day(out[0].departDate)}</div>
      <Legs segments={out} />
      <hr className={styles.divider} />
      <div className={styles.muted}>Home {day(back[0]?.departDate ?? trip.hotel.checkout)}</div>
      <Legs segments={back} />
      <hr className={styles.divider} />
      <div className={styles.row}>
        <span>{trip.hotel.name}</span>
        <span className={styles.muted}>
          {day(trip.hotel.checkin)} – {day(trip.hotel.checkout)}
        </span>
      </div>
    </section>
  );
}
