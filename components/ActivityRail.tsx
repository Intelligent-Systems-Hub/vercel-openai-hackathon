import type { ToolView } from "@/lib/ui/parts";

import styles from "./side.module.css";

const LABELS: Record<string, string> = {
  get_trip: "Read the booked trip",
  check_disruption: "Checked the weather at the connection",
  find_rebooking_options: "Shopped and ranked the ways out",
  search_hotels: "Searched hotels",
  recall_traveler: "Recalled what the traveler said before",
  remember_traveler: "Remembered something about the traveler",
  learn_from_choice: "Learned from the traveler's choice",
  present_options: "Showed the options",
  request_approval: "Asked the traveler to approve",
  execute_rebook: "Rebooked",
  settle_payment: "Settled the difference",
  notify_traveler: "Sent the new itinerary",
  check_hotel_policy: "Read the hotel's refund policy",
  email_hotel: "Emailed the hotel for a refund",
  call_hotel: "Called the hotel for a refund",
  send_trip_summary: "Sent the trip summary",
  add_to_calendar: "Added the flights to the calendar",
};

function status(t: ToolView): { text: string; tone: "run" | "wait" | "ok" | "no" } {
  if (t.state === "approval-requested") return { text: "waiting for the traveler", tone: "wait" };
  if (t.state === "output-denied") return { text: "declined", tone: "no" };
  if (t.state === "output-error") return { text: "failed", tone: "no" };
  if (t.state === "output-available") {
    const o = t.output ?? {};
    if (o.refused || o.error) return { text: "refused", tone: "no" };
    return { text: "done", tone: "ok" };
  }
  return { text: "running", tone: "run" };
}

function Detail({ t }: { t: ToolView }) {
  const o = t.output;
  if (t.name === "request_approval" && t.approval?.requestReason) return <div>{t.approval.requestReason}</div>;
  if (!o) return null;
  if (o.refused || o.error) return <div>{String(o.reason ?? o.error)}</div>;

  switch (t.name) {
    case "check_disruption": {
      const c = o.case as Record<string, unknown> | undefined;
      return c ? (
        <div>
          {String(c.hub)}: {String(c.connectionLeftMinutes)} of {String(c.bookedConnectionMinutes)} minutes left to
          connect (minimum {String(c.minimumConnectMinutes)})
        </div>
      ) : (
        <div>{String(o.reason ?? "no disruption")}</div>
      );
    }
    case "find_rebooking_options": {
      const calls = (o.supplierCalls as { path: string; match: string }[] | undefined) ?? [];
      return (
        <>
          <div>{o.usedWhatYouKnow ? "Ranked using what it learned" : "Ranked by soonest arrival"}</div>
          <ul className={styles.calls}>
            {calls.map((c, i) => (
              <li key={i}>
                <code>{c.path.split("/").pop()}</code> <span className={styles.match}>{c.match}</span>
              </li>
            ))}
          </ul>
        </>
      );
    }
    case "check_hotel_policy":
      return <div>{`${String(o.hotel)}: ${String(o.clarity)}. ${String(o.request)}`}</div>;
    case "email_hotel":
    case "call_hotel":
      return <div>{o.simulated ? "simulated call · " : o.sent === false ? `not sent (${String(o.reason)}) · ` : ""}{String(o.request)}</div>;
    case "send_trip_summary":
      return <div>{o.sent ? `to ${String(o.to)}` : `ready (${String(o.reason)})`}</div>;
    case "remember_traveler":
      return <div>&ldquo;{String(t.input.text ?? "")}&rdquo;</div>;
    case "learn_from_choice":
      return o.learned ? (
        <div>
          &ldquo;{String(o.reason)}&rdquo;: {String(o.graph)}
        </div>
      ) : (
        <div>{String(o.reason)}</div>
      );
    case "execute_rebook": {
      const steps = (o.steps as { step: string; booking: string; ok: boolean; detail: string }[] | undefined) ?? [];
      return (
        <ol className={styles.calls} data-testid="rebook-steps">
          {steps.map((s, i) => (
            <li key={i} className={s.ok ? "" : styles.bad}>
              <code>{s.step}</code> {s.booking} · {s.detail}
            </li>
          ))}
        </ol>
      );
    }
    case "settle_payment":
      return <div>{o.kind === "none" ? "no charge" : `${String(o.kind)} ${String(o.amount)}`}</div>;
    case "notify_traveler":
      return <div>{o.sent ? `sent to ${String(o.to)}` : `not sent: ${String(o.reason ?? "")}`}</div>;
    case "add_to_calendar":
      return <div>{(o.events as string[] | undefined)?.length ?? 0} flights in the calendar file</div>;
    default:
      return null;
  }
}

/** What the agent did, step by step: the agency, made visible. */
export function ActivityRail({ tools, model }: { tools: ToolView[]; model?: string }) {
  return (
    <section className={styles.panel} aria-label="Agent activity">
      <header className={styles.panelHead}>
        <span>Agent activity</span>
        {model && <span className={styles.model}>{model === "openai" ? "OpenAI" : "scripted model"}</span>}
      </header>
      {tools.length === 0 && <p className={styles.empty}>Nothing yet. Fire the storm to start.</p>}
      <ol className={styles.rail}>
        {tools.map((t) => {
          const s = status(t);
          return (
            <li key={t.id} className={styles.event} data-tool={t.name}>
              <div className={styles.eventHead}>
                <span>{LABELS[t.name] ?? t.name}</span>
                <span className={`${styles.status} ${styles[s.tone]}`}>{s.text}</span>
              </div>
              <div className={styles.eventBody}>
                <Detail t={t} />
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
