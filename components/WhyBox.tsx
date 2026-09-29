"use client";

import { useState } from "react";

import styles from "./cards.module.css";

type Props = {
  /** What the traveler picked instead of the recommendation, e.g. "the overnight at ORD". */
  choice: string;
  onSubmit: (reason: string) => void;
  onSkip: () => void;
  disabled?: boolean;
};

export const REASON_CHIPS = [
  "Nora needs a real night's sleep",
  "Too tight a day with a baby",
  "We'd rather not land late",
];

/**
 * Asked only when the traveler picks something other than the recommendation.
 * Their answer is what the agent learns from: it becomes a node on the context
 * graph and can change the ranking on the next trip.
 */
export function WhyBox({ choice, onSubmit, onSkip, disabled }: Props) {
  const [reason, setReason] = useState("");
  const send = (text: string) => text.trim() && onSubmit(text.trim());
  return (
    <section className={`${styles.card} ${styles.sheet}`} aria-label="Why this one?">
      <div className={styles.eyebrow}>
        <span>Why this one?</span>
      </div>
      <div className={styles.muted}>You picked {choice} over my recommendation. Tell me why and I&apos;ll remember it next time.</div>
      <div className={styles.facts}>
        {REASON_CHIPS.map((c) => (
          <button key={c} type="button" className={styles.chip} onClick={() => send(c)} disabled={disabled}>
            {c}
          </button>
        ))}
      </div>
      <form
        className={styles.actions}
        onSubmit={(e) => {
          e.preventDefault();
          send(reason);
        }}
      >
        <input
          aria-label="Why you chose it"
          className={styles.reason}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="In your words"
          disabled={disabled}
        />
        <button className={styles.button} type="submit" disabled={disabled || !reason.trim()}>
          Save
        </button>
      </form>
      <button type="button" className={`${styles.button} ${styles.buttonQuiet}`} onClick={onSkip} disabled={disabled}>
        Skip, just book it
      </button>
    </section>
  );
}
