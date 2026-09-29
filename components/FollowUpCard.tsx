import styles from "./cards.module.css";

export type NotifyOutput = { channel: "email" | "sms"; to: string; sent: boolean; reason?: string };
export type CalendarOutput = { url: string; events: string[] };

/** What happens after the rebook: the itinerary sent, the flights for the calendar. */
export function FollowUpCard({ notified, calendar }: { notified?: NotifyOutput; calendar?: CalendarOutput }) {
  if (!notified && !calendar) return null;
  return (
    <section className={styles.card} aria-label="Follow-up">
      <div className={styles.eyebrow}>
        <span>Follow-up</span>
      </div>
      {notified && (
        <div className={styles.row}>
          <span>{notified.channel === "email" ? "Itinerary email" : "Itinerary text"}</span>
          <span className={styles.muted} data-testid="notify-status">
            {notified.sent ? `sent to ${notified.to}` : notified.to ? `ready for ${notified.to} (${notified.reason})` : "ready"}
          </span>
        </div>
      )}
      {calendar && (
        <a className={`${styles.button} ${styles.buttonQuiet}`} href={calendar.url} download data-testid="calendar-link">
          Add {calendar.events.length} flights to your calendar
        </a>
      )}
    </section>
  );
}
