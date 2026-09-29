import { cents } from "@/lib/ui/format";

import styles from "./cards.module.css";

export type SettleOutput = {
  kind: "charge" | "refund" | "none";
  amountCents: number;
  captureId?: string;
  refundId?: string;
  alreadySettled?: boolean;
};

/** What moved, once. */
export function LedgerCard({ entry }: { entry: SettleOutput }) {
  const label = entry.kind === "charge" ? "Charged" : entry.kind === "refund" ? "Refunded" : "No charge";
  const ref = entry.captureId ?? entry.refundId;
  return (
    <section className={styles.card} aria-label="Payment">
      <div className={styles.eyebrow}>
        <span>Payment</span>
        <span>PayPal sandbox</span>
      </div>
      <div className={styles.row}>
        <span>{label}</span>
        <span className={styles.price} data-testid="ledger-amount">
          {entry.kind === "none" ? "$0.00" : cents(Math.abs(entry.amountCents))}
        </span>
      </div>
      {ref && <div className={styles.muted}>Reference {ref}</div>}
    </section>
  );
}
