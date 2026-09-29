import type { CallLine } from "@/lib/actions/call";

import styles from "./cards.module.css";

export type PolicyOutput = { hotel: string; policy: string; source: string; clarity: "clear" | "unclear"; reading: string; request: string };
export type RefundOutput = {
  requested?: boolean;
  to?: string;
  sent?: boolean;
  placed?: boolean;
  simulated?: boolean;
  reason?: string;
  request?: string;
  transcript?: CallLine[];
  outcome?: string;
};

/** The destination hotel's policy, as the agent read it. */
export function PolicyCard({ policy }: { policy: PolicyOutput }) {
  return (
    <section className={styles.card} aria-label="Hotel policy">
      <div className={styles.eyebrow}>
        <span>{policy.hotel}: refund policy</span>
        <span className={styles.badge} data-testid="policy-clarity">
          {policy.clarity === "clear" ? "Clear: email it" : "Unclear: call"}
        </span>
      </div>
      <blockquote className={styles.muted}>&ldquo;{policy.policy}&rdquo;</blockquote>
      <div className={styles.muted}>Source: {policy.source}. Read as {policy.clarity}: {policy.reading}.</div>
    </section>
  );
}

/** The refund request: an email sent, or a call made, and what it asks for. */
export function RefundCard({
  route,
  result,
  live,
}: {
  route: "email" | "call";
  result: RefundOutput;
  live?: { transcript?: CallLine[]; outcome?: string; live?: boolean };
}) {
  const transcript = live?.transcript?.length ? live.transcript : (result.transcript ?? []);
  const outcome = live?.outcome ?? result.outcome;
  const status =
    route === "email"
      ? result.sent
        ? `Emailed ${result.to}`
        : `Composed for ${result.to || "the hotel"} (not sent: ${result.reason})`
      : result.simulated
        ? "Simulated call (no phone was dialled)"
        : live?.live
          ? `On the phone with the hotel (${result.to})…`
          : `Called ${result.to}`;
  return (
    <section className={styles.card} aria-label="Refund request">
      <div className={styles.eyebrow}>
        <span>{route === "email" ? "Refund request by email" : "Calling the hotel"}</span>
      </div>
      <div className={styles.muted} data-testid="refund-status">
        {status}
      </div>
      {result.request && (
        <p className={styles.evidence} data-testid="refund-request">
          {result.request}
        </p>
      )}
      {transcript.length > 0 && (
        <ol className={styles.steps} data-testid="call-transcript">
          {transcript.map((l, i) => (
            <li key={i}>
              <strong>{l.who === "agent" ? "Agent" : "Hotel"}:</strong> {l.text}
            </li>
          ))}
        </ol>
      )}
      {outcome && <div className={styles.ok}>Hotel: {outcome}</div>}
    </section>
  );
}

/** Everything the agent did on this trip, read from the trip state. */
export function ReceiptCard({ actions, to, sent, reason }: { actions: string[]; to?: string; sent?: boolean; reason?: string }) {
  return (
    <section className={styles.card} aria-label="Actions taken">
      <div className={styles.eyebrow}>
        <span>Actions taken</span>
      </div>
      <ul className={styles.steps} data-testid="actions-taken">
        {actions.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      <div className={styles.muted} data-testid="summary-status">
        {sent ? `Trip summary sent to ${to}` : `Trip summary ready${to ? ` for ${to}` : ""} (${reason ?? "not sent"})`}
      </div>
    </section>
  );
}
