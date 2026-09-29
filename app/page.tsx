"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { ActivityRail } from "@/components/ActivityRail";
import { AlertCard } from "@/components/AlertCard";
import { ApprovalSheet } from "@/components/ApprovalSheet";
import { BookingCard, type RebookOutput } from "@/components/BookingCard";
import { ContextGraph, type ContextViewData } from "@/components/ContextGraph";
import { DirectorPanel } from "@/components/DirectorPanel";
import { FollowUpCard, type CalendarOutput, type NotifyOutput } from "@/components/FollowUpCard";
import { LedgerCard, type SettleOutput } from "@/components/LedgerCard";
import { PolicyCard, ReceiptCard, RefundCard, type PolicyOutput, type RefundOutput } from "@/components/RefundCard";
import { RichText } from "@/components/RichText";
import { TripCard } from "@/components/TripCard";
import { WhyBox } from "@/components/WhyBox";
import { offered } from "@/lib/agent/offered";
import type { ContextMode, RepairCase, RepairOption, TravelerMemory, Trip } from "@/lib/domain/types";
import { allTools, NOTICE_PREFIX, toolView } from "@/lib/ui/parts";

import styles from "./page.module.css";

type DirectorState = {
  model: "openai" | "mock";
  openaiConfigured: boolean;
  storm: boolean;
  learner: boolean;
  trip: Trip;
  repairCase?: RepairCase;
  options?: RepairOption[];
  rebook?: { optionId: RepairOption["id"] };
  refund?: { transcript?: { who: "agent" | "hotel"; text: string }[]; outcome?: string; live?: boolean };
  memory: TravelerMemory;
  context?: ContextViewData;
};

const CHOOSE_TEXT: Record<RepairOption["id"], string> = {
  "overnight-at-hub": "Book the overnight at ORD",
  "later-connection": "Book the later connection tonight",
};

const CHOICE_NAME: Record<RepairOption["id"], string> = {
  "overnight-at-hub": "the overnight at ORD",
  "later-connection": "the later connection tonight",
};

function sessionFromUrl(): string {
  if (typeof window === "undefined") return "demo";
  return new URLSearchParams(window.location.search).get("session") || "demo";
}

export default function Home() {
  const [sessionId] = useState(sessionFromUrl);
  const [director, setDirector] = useState<DirectorState>();
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  /** An option the traveler picked over the recommendation, waiting for them to say why. */
  const [overriding, setOverriding] = useState<RepairOption["id"]>();

  // The server holds the truth about the trip; re-read it on load and whenever a turn ends.
  const load = useCallback(async (): Promise<DirectorState | undefined> => {
    const res = await fetch(`/api/director?sessionId=${encodeURIComponent(sessionId)}`);
    return res.ok ? res.json() : undefined;
  }, [sessionId]);
  const refresh = useCallback(async () => {
    const state = await load();
    if (state) setDirector(state);
  }, [load]);
  useEffect(() => {
    let live = true;
    load().then((state) => {
      if (live && state) setDirector(state);
    });
    return () => {
      live = false;
    };
  }, [load]);

  // While the agent is on a real call with the hotel, follow its transcript as it happens.
  const liveCall = Boolean(director?.refund?.live);
  useEffect(() => {
    if (!liveCall) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [liveCall, refresh]);

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat", body: { sessionId } }), [sessionId]);
  const { messages, sendMessage, setMessages, status, addToolApprovalResponse } = useChat({
    id: sessionId,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => void refresh(),
  });

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/director", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...body }),
      });
      return res.ok ? await res.json() : undefined;
    } finally {
      setBusy(false);
    }
  };

  const onStorm = async () => {
    const res = await act({ action: "storm" });
    await refresh();
    if (res?.message) void sendMessage({ text: res.message });
  };
  const onReset = async (action: "reset-trip" | "reset-all" | "next-trip") => {
    setOverriding(undefined);
    await act({ action });
    setMessages([]);
    await refresh();
  };
  const onLens = async (mode: ContextMode) => {
    await act({ action: "context", mode });
    await refresh();
  };
  const onModel = async (mode: "openai" | "mock") => {
    await act({ action: "model", mode });
    await refresh();
  };

  const say = (text: string) => {
    if (text.trim() && status === "ready") void sendMessage({ text: text.trim() });
  };
  const choose = (o: RepairOption, top: RepairOption | undefined) => {
    if (top && o.id !== top.id) setOverriding(o.id);
    else say(CHOOSE_TEXT[o.id]);
  };
  const explain = (reason?: string) => {
    if (!overriding) return;
    say(reason ? `${CHOOSE_TEXT[overriding]} instead. Why: ${reason}` : CHOOSE_TEXT[overriding]);
    setOverriding(undefined);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    say(input);
    setInput("");
  };

  const tools = allTools(messages);
  const lastAlertId = [...tools].reverse().find((t) => t.name === "present_options" && t.output?.options)?.id;
  const rebooked = Boolean(director?.rebook);
  const newLeg = director?.options?.find((o) => o.id === director.rebook?.optionId)?.changed[0]?.now;
  const thinking = status === "submitted" || status === "streaming";

  return (
    <main className={styles.stage}>
      <header className={styles.bar}>
        <strong>Trip Repair Agent</strong>
        <span>notices the broken connection, learns from what you choose, and fixes it</span>
      </header>

      <div className={styles.grid}>
        <section className={styles.phone} aria-label="Traveler app">
          <div className={styles.screen}>
            <div className={styles.appBar}>
              <span>My trips</span>
              <span className={styles.dot} data-live={director?.storm ? "storm" : "calm"} />
            </div>

            <div className={styles.thread}>
              {director?.trip && <TripCard trip={director.trip} />}

              {messages.map((m) =>
                m.parts.map((part, i) => {
                  const key = `${m.id}-${i}`;
                  if (part.type === "text") {
                    if (m.role === "user" && part.text.startsWith(NOTICE_PREFIX)) {
                      return (
                        <div key={key} className={styles.notice} role="status">
                          {part.text}
                        </div>
                      );
                    }
                    return (
                      <p key={key} className={m.role === "user" ? styles.me : styles.agent}>
                        {m.role === "user" ? part.text : <RichText text={part.text} />}
                      </p>
                    );
                  }
                  const t = toolView(part);
                  if (!t) return null;
                  if (t.name === "present_options" && t.output?.options) {
                    const live = t.id === lastAlertId && !rebooked && !thinking;
                    // The latest alert follows the live ranking, so flipping the lens re-draws it.
                    const shown =
                      t.id === lastAlertId && director?.options && director.repairCase
                        ? offered(director.options, director.context?.mode)
                        : (t.output.options as RepairOption[]);
                    return (
                      <div key={key}>
                        <AlertCard
                          repairCase={director?.repairCase}
                          options={shown}
                          learnerApplied={Boolean(t.output.learnerApplied)}
                          onChoose={live && !overriding ? (o) => choose(o, shown[0]) : undefined}
                        />
                        {live && overriding && (
                          <WhyBox choice={CHOICE_NAME[overriding]} onSubmit={(r) => explain(r)} onSkip={() => explain()} />
                        )}
                      </div>
                    );
                  }
                  const asks = t.name === "request_approval" || t.name === "email_hotel" || t.name === "call_hotel";
                  if (asks && t.state === "approval-requested" && !t.approval?.isAutomatic) {
                    return (
                      <ApprovalSheet
                        key={key}
                        reason={t.approval?.requestReason ?? "Approve this change"}
                        onApprove={() => addToolApprovalResponse({ id: t.approval!.id, approved: true })}
                        onDecline={() => addToolApprovalResponse({ id: t.approval!.id, approved: false })}
                      />
                    );
                  }
                  if (t.name === "execute_rebook" && t.output?.steps) {
                    return <BookingCard key={key} result={t.output as unknown as RebookOutput} newLeg={newLeg} />;
                  }
                  if (t.name === "settle_payment" && t.output?.kind) {
                    return <LedgerCard key={key} entry={t.output as unknown as SettleOutput} />;
                  }
                  if (t.name === "notify_traveler" && t.output?.channel) {
                    return <FollowUpCard key={key} notified={t.output as unknown as NotifyOutput} />;
                  }
                  if (t.name === "check_hotel_policy" && t.output?.clarity) {
                    return <PolicyCard key={key} policy={t.output as unknown as PolicyOutput} />;
                  }
                  if ((t.name === "email_hotel" || t.name === "call_hotel") && t.output?.requested) {
                    return (
                      <RefundCard
                        key={key}
                        route={t.name === "email_hotel" ? "email" : "call"}
                        result={t.output as unknown as RefundOutput}
                        live={t.name === "call_hotel" ? director?.refund : undefined}
                      />
                    );
                  }
                  if (t.name === "send_trip_summary" && t.output?.actions) {
                    const o = t.output as { actions: string[]; to?: string; sent?: boolean; reason?: string };
                    return <ReceiptCard key={key} actions={o.actions} to={o.to} sent={o.sent} reason={o.reason} />;
                  }
                  if (t.name === "add_to_calendar" && t.output?.url) {
                    return <FollowUpCard key={key} calendar={t.output as unknown as CalendarOutput} />;
                  }
                  return null;
                }),
              )}
              {thinking && <p className={styles.typing}>Working on it…</p>}
            </div>

            <form className={styles.composer} onSubmit={onSubmit}>
              <div className={styles.inputRow}>
                <input
                  aria-label="Message"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Message your concierge"
                />
                <button type="submit" disabled={!input.trim() || status !== "ready"}>
                  Send
                </button>
              </div>
            </form>
          </div>
        </section>

        <aside className={styles.side}>
          <DirectorPanel
            model={director?.model}
            openaiConfigured={director?.openaiConfigured}
            storm={director?.storm}
            memory={director?.memory}
            busy={busy || thinking}
            onStorm={onStorm}
            onResetTrip={() => onReset("reset-trip")}
            onResetAll={() => onReset("reset-all")}
            onNextTrip={() => onReset("next-trip")}
            learner={director?.learner}
            onLearner={async (on) => {
              await act({ action: "learner", on });
              await refresh();
            }}
            onModel={onModel}
          />
          <ContextGraph context={director?.context} options={director?.options} busy={busy || thinking} onMode={onLens} />
          <ActivityRail tools={tools} model={director?.model} />
        </aside>
      </div>
    </main>
  );
}
