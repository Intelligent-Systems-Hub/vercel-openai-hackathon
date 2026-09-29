import type { RepairCase, RepairOption } from "@/lib/domain/types";
import { lateBy, money } from "@/lib/ui/format";

import styles from "./cards.module.css";
import { Leg } from "./Legs";

type Props = {
  repairCase?: Pick<RepairCase, "hub" | "bookedConnectionMinutes" | "connectionLeftMinutes" | "minimumConnectMinutes">;
  options: RepairOption[];
  learnerApplied: boolean;
  /** Called when the traveler picks an option; disabled when absent. */
  onChoose?: (option: RepairOption) => void;
};

function OptionCard({ option, top, onChoose }: { option: RepairOption; top: boolean; onChoose?: Props["onChoose"] }) {
  return (
    <article className={`${styles.option} ${top ? styles.optionTop : ""}`} data-testid={`option-${option.id}`}>
      <div className={styles.optionHead}>
        <div>
          {top && <div className={styles.badge}>Recommended</div>}
          <div className={styles.title}>{option.title}</div>
        </div>
        <div className={styles.price}>
          {option.roomUnpriced ? "Room not priced" : option.priceDelta > 0 ? money(option.priceDelta) : "No extra cost"}
        </div>
      </div>

      {option.changed.map(({ was, now }) => (
        <div key={`${now.carrier}${now.number}`} className={styles.legs}>
          <Leg segment={was} was />
          <Leg segment={now} />
        </div>
      ))}

      <div className={styles.facts}>
        <span className={styles.chip}>Arrives {lateBy(option.arrivalDeltaMinutes)}</span>
        {option.accommodations.map((a) => (
          <span key={a} className={styles.chip}>
            {a}
          </span>
        ))}
      </div>

      {option.priceNote && <div className={styles.muted}>{option.priceNote}</div>}

      {option.reasoning && (
        <div className={styles.why} data-testid="reasoning">
          <strong>{option.reasoning.headline}</strong>
          <ul>
            {option.reasoning.because.map((b) => (
              <li key={b.text}>
                {b.text}
                {b.path && <span className={styles.path}>{b.path.join(" → ")}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {option.tradeoff && <div className={styles.tradeoff}>Trade-off: {option.tradeoff}</div>}

      {onChoose && (
        <button className={`${styles.button} ${top ? "" : styles.buttonQuiet}`} onClick={() => onChoose(option)}>
          Choose this
        </button>
      )}
    </article>
  );
}

/** The disruption and the ranked ways out. */
export function AlertCard({ repairCase, options, learnerApplied, onChoose }: Props) {
  return (
    <section className={`${styles.card} ${styles.alert}`} aria-label="Your connection is at risk">
      <div className={styles.eyebrow}>
        <span>Connection at risk</span>
        {learnerApplied && <span className={styles.badge}>Using what I learned</span>}
      </div>
      {repairCase && (
        <p className={styles.evidence}>
          A storm at {repairCase.hub} delays your first flight. Your {repairCase.bookedConnectionMinutes}-minute connection
          drops to <strong>{repairCase.connectionLeftMinutes} minutes</strong>, under the {repairCase.minimumConnectMinutes}
          -minute minimum.
        </p>
      )}
      {options.map((o, i) => (
        <OptionCard key={o.id} option={o} top={i === 0} onChoose={onChoose} />
      ))}
    </section>
  );
}
