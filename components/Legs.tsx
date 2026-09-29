import type { Segment } from "@/lib/domain/types";
import { flightNo, nextDayMark } from "@/lib/ui/format";

import styles from "./cards.module.css";

export function Leg({ segment, was = false }: { segment: Segment; was?: boolean }) {
  return (
    <div className={`${styles.leg} ${was ? styles.was : ""}`} data-testid="leg">
      <span className={styles.legFlight}>{flightNo(segment)}</span>
      <span className={styles.legRoute}>
        {segment.from} → {segment.to}
      </span>
      <span className={styles.legTime}>
        {segment.departTime}–{segment.arriveTime}
        {nextDayMark(segment) && <sup className={styles.sup}>{nextDayMark(segment)}</sup>}
      </span>
    </div>
  );
}

export function Legs({ segments }: { segments: Segment[] }) {
  return (
    <div className={styles.legs}>
      {segments.map((s) => (
        <Leg key={`${s.carrier}${s.number}${s.departDate}`} segment={s} />
      ))}
    </div>
  );
}
