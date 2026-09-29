import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { Store } from "@/lib/state";

type Env = Record<string, string | undefined>;

// Which model drives the agent. OpenAI when configured; otherwise, or when the
// director flips the switch, a scripted stand-in that plays the demo's turns
// deterministically, so tests, rehearsals without a key, and a misbehaving
// model on stage all have the same fallback. The switch lives in the store,
// so it takes effect on the next request with no redeploy.

export type ModelMode = "openai" | "mock";

const MODE_KEY = "config:model";

export function openAiConfigured(env: Env = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY && env.OPENAI_MODEL);
}

export async function currentMode(store: Store, env: Env = process.env): Promise<ModelMode> {
  const chosen = (await store.get<ModelMode>(MODE_KEY)) ?? (env.AGENT_MODEL as ModelMode | undefined);
  if (chosen === "openai" && openAiConfigured(env)) return "openai";
  if (chosen === "mock") return "mock";
  return openAiConfigured(env) ? "openai" : "mock";
}

export async function setMode(store: Store, mode: ModelMode): Promise<void> {
  await store.set(MODE_KEY, mode);
}

export async function resolveModel(store: Store, env: Env = process.env): Promise<{ model: LanguageModel; mode: ModelMode }> {
  const mode = await currentMode(store, env);
  return mode === "openai"
    ? { model: openai(env.OPENAI_MODEL!), mode }
    : { model: scriptedModel(), mode };
}

// ── the scripted stand-in ────────────────────────────────────────────────────

type Part = Record<string, unknown>;
type Message = { role: string; content: string | Part[] };
type Action = { tool: string; input: Record<string, unknown> } | { text: string };

const parts = (m: Message | undefined): Part[] => (Array.isArray(m?.content) ? m.content : []);
const textOf = (m: Message | undefined) =>
  typeof m?.content === "string" ? m.content : parts(m).filter((p) => p.type === "text").map((p) => String(p.text)).join(" ");

function resultValue(part: Part): Record<string, unknown> {
  const output = (part.output ?? {}) as Part;
  return output.type === "json" && output.value && typeof output.value === "object"
    ? (output.value as Record<string, unknown>)
    : { denied: output.type === "execution-denied" };
}

/** The approval id the traveler granted most recently in this conversation. */
function lastApprovalId(prompt: Message[]): string | undefined {
  for (const m of [...prompt].reverse())
    for (const p of parts(m))
      if (p.type === "tool-result" && p.toolName === "request_approval") {
        const id = resultValue(p).approvalId;
        if (typeof id === "string") return id;
      }
  return undefined;
}

/** What the demo's agent does next, given the conversation so far. */
export function nextAction(prompt: Message[]): Action {
  const last = prompt.at(-1);

  /** The latest result of a tool, anywhere in the conversation. */
  const earlier = (name: string) => [...prompt].reverse().flatMap(parts).find((p) => p.type === "tool-result" && p.toolName === name);
  /** Whether a tool already ran in this turn, since the traveler last spoke. */
  const thisTurn = (name: string) => {
    const from = prompt.findLastIndex((m) => m.role === "user");
    return prompt.slice(from + 1).flatMap(parts).some((p) => p.type === "tool-result" && p.toolName === name);
  };

  if (last?.role === "tool") {
    const result = [...parts(last)].reverse().find((p) => p.type === "tool-result");
    if (!result) return { text: "Okay." };
    const value = resultValue(result);
    switch (result.toolName) {
      case "check_disruption":
        return value.disrupted
          ? { tool: "find_rebooking_options", input: {} }
          : { text: "Your trip looks fine right now. I'll keep watching the weather at your connection." };
      case "remember_traveler":
        return { tool: "find_rebooking_options", input: {} };
      case "learn_from_choice":
        return value.chose ? { tool: "request_approval", input: { optionId: value.chose } } : { text: "Tell me which option you want." };
      case "find_rebooking_options":
        return value.error ? { text: "Noted. I'll use that if anything goes wrong with the trip." } : { tool: "present_options", input: {} };
      case "present_options": {
        const top = (value.options as Part[] | undefined)?.[0];
        // It already knows what this traveler chooses: propose it straight away, and wait for their yes.
        if (value.learnerApplied && top && !thisTurn("request_approval")) {
          return { tool: "request_approval", input: { optionId: top.id } };
        }
        const reasoning = top?.reasoning as { headline?: string } | undefined;
        return {
          text: top
            ? `A storm at ORD will make you miss your connection. ${reasoning?.headline ? `${reasoning.headline}, so ` : ""}I recommend: ${top.title}. Tell me which option you want and I'll book it once you approve.`
            : "I couldn't find a way out yet.",
        };
      }
      case "request_approval":
        return value.approved
          ? { tool: "execute_rebook", input: { approvalId: value.approvalId } }
          : { text: "No problem, I haven't changed anything." };
      case "execute_rebook": {
        const approvalId = lastApprovalId(prompt);
        return value.outcome === "rebooked" && approvalId
          ? { tool: "settle_payment", input: { approvalId } }
          : { text: `I couldn't complete the rebooking${value.reason ? `: ${value.reason}` : ""}. Your original booking is untouched.` };
      }
      case "settle_payment":
        return { tool: "check_hotel_policy", input: {} };
      case "check_hotel_policy":
        return value.refused ? { tool: "send_trip_summary", input: {} } : { tool: String(value.next), input: {} };
      case "email_hotel":
      case "call_hotel":
        return { tool: "send_trip_summary", input: {} };
      case "send_trip_summary":
      case "notify_traveler":
        return { tool: "add_to_calendar", input: {} };
      case "add_to_calendar": {
        const paid = earlier("settle_payment");
        const charge = paid ? resultValue(paid) : {};
        const summary = earlier("send_trip_summary");
        const sent = summary && resultValue(summary);
        const charged = charge.kind === "none" ? "nothing was charged" : `${String(charge.amount)} was charged`;
        const told = sent?.sent ? `I sent you a trip summary at ${String(sent.to)}` : "your trip summary is ready";
        const emailed = earlier("email_hotel");
        const called = earlier("call_hotel");
        const hotel = String(resultValue(earlier("check_hotel_policy") ?? {}).hotel ?? "the hotel");
        const refund =
          emailed && resultValue(emailed).requested
            ? `I emailed ${hotel}: ${String(resultValue(emailed).request)} `
            : called && resultValue(called).requested
              ? `I called ${hotel}${resultValue(called).simulated ? " (a simulated call)" : ""}: ${String(resultValue(called).request)} `
              : "";
        const opener = "Done. ";
        return { text: `${opener}You're rebooked, and ${charged}. ${refund}${told[0].toUpperCase()}${told.slice(1)}, and you can add the flights to your calendar.` };
      }
      default:
        return { text: "Okay." };
    }
  }

  const said = textOf(last).toLowerCase();
  if (/\b(baby|infant)\b/.test(said)) {
    return { tool: "remember_traveler", input: { kind: "travels_with_infant", text: textOf(last) } };
  }
  if (/\b(book|approve|take|go with|choose)\b/.test(said)) {
    const optionId = /\b(later|same.day|tonight)\b/.test(said) ? "later-connection" : "overnight-at-hub";
    const why = /\bwhy:\s*(.+)$/i.exec(textOf(last));
    if (why) return { tool: "learn_from_choice", input: { optionId, reason: why[1].trim() } };
    return { tool: "request_approval", input: { optionId } };
  }
  if (/\b(storm|weather|alert|disrupt|check)\b/.test(said)) return { tool: "check_disruption", input: {} };
  return { text: "I'm keeping an eye on your trip. Tell me if anything changes." };
}

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

let callCount = 0;

function content(action: Action) {
  if ("text" in action) {
    return { content: [{ type: "text" as const, text: action.text }], finishReason: { unified: "stop" as const, raw: undefined } };
  }
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `mock-${++callCount}`,
        toolName: action.tool,
        input: JSON.stringify(action.input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
  };
}

export function scriptedModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "scripted",
    modelId: "demo-script",
    doGenerate: async ({ prompt }) => ({ ...content(nextAction(prompt as Message[])), usage: USAGE, warnings: [] }),
    doStream: async ({ prompt }) => {
      const { content: out, finishReason } = content(nextAction(prompt as Message[]));
      const chunks: Part[] = [];
      for (const part of out) {
        if (part.type === "text") {
          chunks.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: part.text }, { type: "text-end", id: "t" });
        } else {
          chunks.push(part);
        }
      }
      chunks.push({ type: "finish", finishReason, usage: USAGE });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
          },
        }),
      } as never;
    },
  });
}
