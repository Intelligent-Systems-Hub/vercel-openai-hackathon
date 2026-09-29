import type { TravelerMemory } from "@/lib/domain/types";

import styles from "./side.module.css";

type Props = {
  model?: "openai" | "mock";
  openaiConfigured?: boolean;
  storm?: boolean;
  memory?: TravelerMemory;
  busy?: boolean;
  onStorm: () => void;
  onResetTrip: () => void;
  onResetAll: () => void;
  onNextTrip: () => void;
  learner?: boolean;
  onLearner: (on: boolean) => void;
  onModel: (mode: "openai" | "mock") => void;
};

/** The presenter's controls. None of them act for the agent: the storm only makes the weather real. */
export function DirectorPanel(p: Props) {
  return (
    <section className={styles.panel} aria-label="Director">
      <header className={styles.panelHead}>
        <span>Director</span>
      </header>
      <div className={styles.controls}>
        <button className={styles.primary} onClick={p.onStorm} disabled={p.busy || p.storm}>
          {p.storm ? "Storm is live" : "Fire the storm at ORD"}
        </button>
        <button className={styles.ghost} onClick={p.onResetTrip} disabled={p.busy}>
          Reset trip (keep memory)
        </button>
        <button className={styles.ghost} onClick={p.onNextTrip} disabled={p.busy}>
          Next trip (keep memory)
        </button>
        <button className={styles.ghost} onClick={p.onResetAll} disabled={p.busy}>
          Reset all
        </button>
      </div>

      <div className={styles.field}>
        <span>Model</span>
        <div className={styles.toggle} role="group" aria-label="Model">
          <button
            aria-pressed={p.model === "openai"}
            onClick={() => p.onModel("openai")}
            disabled={p.busy || !p.openaiConfigured}
            title={p.openaiConfigured ? undefined : "Set OPENAI_API_KEY and OPENAI_MODEL"}
          >
            OpenAI
          </button>
          <button aria-pressed={p.model === "mock"} onClick={() => p.onModel("mock")} disabled={p.busy}>
            Scripted
          </button>
        </div>
      </div>

      <div className={styles.field}>
        <span>What the agent remembers</span>
        {p.memory?.facts.length ? (
          <ul className={styles.memory} data-testid="memory">
            {p.memory.facts.map((f, i) => (
              <li key={i}>
                {f.kind === "learned_choice"
                  ? "Learned from a choice: "
                  : f.kind === "refund_decision"
                    ? `Asked ${f.hotel} for $${(f.amountCents / 100).toFixed(2)} back, because `
                    : ""}
                &ldquo;{f.text}&rdquo;
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>Nothing yet.</p>
        )}
      </div>

      <div className={styles.field}>
        <span>Learner</span>
        <div className={styles.toggle} role="group" aria-label="Learner">
          <button aria-pressed={!p.learner} onClick={() => p.onLearner(false)} disabled={p.busy}>
            Off
          </button>
          <button aria-pressed={Boolean(p.learner)} onClick={() => p.onLearner(true)} disabled={p.busy}>
            On
          </button>
        </div>
      </div>
    </section>
  );
}
