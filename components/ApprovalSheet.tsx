import { REFUND_PREFIX } from "@/lib/agent/approval-text";

import styles from "./cards.module.css";

type Props = {
  /**
   * The server's description of what is being approved: "Overnight at ORD…: $401.79", optionally followed by
   * " | " and what else the same yes covers; or "Refund request · Bow River Lodge, by email: $520.00".
   */
  reason: string;
  onApprove: () => void;
  onDecline: () => void;
  disabled?: boolean;
};

/** Splits "title: $amount | also" into its parts; the amount is what the traveler must see. */
export function parseReason(reason: string): { what: string; amount: string; also?: string } {
  const [main, also] = reason.split(" | ");
  const at = main.lastIndexOf(": ");
  const parts = at < 0 ? { what: main, amount: "" } : { what: main.slice(0, at), amount: main.slice(at + 2) };
  return also ? { ...parts, also } : parts;
}

/** Nothing is booked, charged or asked of a hotel until the traveler taps yes here. */
export function ApprovalSheet({ reason, onApprove, onDecline, disabled }: Props) {
  const { what, amount, also } = parseReason(reason);
  const refund = what.startsWith(REFUND_PREFIX);
  return (
    <section className={`${styles.card} ${styles.sheet}`} aria-label={refund ? "Confirm refund request" : "Approve this change"}>
      <div className={styles.eyebrow}>
        <span>{refund ? "Ask the hotel for a refund?" : "Approve this change"}</span>
      </div>
      <div className={styles.title}>{refund ? what.slice(REFUND_PREFIX.length) : what}</div>
      <p className={styles.amount} data-testid="approval-amount">
        {amount}
      </p>
      <div className={styles.muted}>
        {refund
          ? "For the night you'll miss. Nothing is charged; the hotel decides."
          : "Your new tickets are issued before your old ones are released."}
      </div>
      {also && (
        <div className={styles.evidence} data-testid="approval-also">
          {also}
        </div>
      )}
      <div className={styles.actions}>
        <button className={`${styles.button} ${styles.buttonQuiet}`} onClick={onDecline} disabled={disabled}>
          Not now
        </button>
        <button className={styles.button} onClick={onApprove} disabled={disabled}>
          {refund ? `Yes, request ${amount}` : `Approve ${amount}`}
        </button>
      </div>
    </section>
  );
}
