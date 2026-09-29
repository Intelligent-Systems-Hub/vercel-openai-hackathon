import { z } from "zod";

import { currentMode, openAiConfigured, setMode } from "@/lib/agent/model";
import { rerank } from "@/lib/agent/tools";
import { contextView } from "@/lib/graph/view";
import { getStore, Session } from "@/lib/state";

// The presenter's controls: fire the storm, reset between runs, and switch
// the model without a redeploy. The storm only makes the weather alert live;
// the agent still has to notice it and act.

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("storm"), sessionId: z.string().optional() }),
  z.object({ action: z.literal("reset-trip"), sessionId: z.string().optional() }),
  z.object({ action: z.literal("reset-all"), sessionId: z.string().optional() }),
  z.object({ action: z.literal("next-trip"), sessionId: z.string().optional() }),
  z.object({ action: z.literal("learner"), on: z.boolean(), sessionId: z.string().optional() }),
  z.object({ action: z.literal("model"), mode: z.enum(["openai", "mock"]) }),
  z.object({ action: z.literal("context"), mode: z.enum(["context", "booking"]), sessionId: z.string().optional() }),
]);

export async function GET(req: Request) {
  const store = getStore();
  const sessionId = new URL(req.url).searchParams.get("sessionId") || "demo";
  const session = new Session(sessionId, store);
  const state = await session.state();
  const memory = await session.memory();
  return Response.json({
    context: contextView(state, memory),
    model: await currentMode(store),
    openaiConfigured: openAiConfigured(),
    storm: Boolean(state.storm),
    learner: Boolean(state.learner),
    trip: state.trip,
    repairCase: state.repairCase,
    options: state.options,
    rebook: state.rebook,
    ledger: state.ledger,
    refund: state.refund && {
      transcript: state.refund.transcript,
      outcome: state.refund.outcome,
      // A real call still in progress: the phone polls for its transcript.
      live: Boolean(state.refund.callSid && !state.refund.outcome && !state.refund.simulated),
    },
    memory: await session.memory(),
  });
}

export async function POST(req: Request) {
  const parsed = Action.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "unknown director action" }, { status: 400 });
  const body = parsed.data;
  const store = getStore();

  if (body.action === "model") {
    if (body.mode === "openai" && !openAiConfigured()) {
      return Response.json({ error: "OPENAI_API_KEY and OPENAI_MODEL are not set" }, { status: 409 });
    }
    await setMode(store, body.mode);
    return Response.json({ ok: true, model: body.mode });
  }

  const session = new Session(body.sessionId || "demo", store);
  if (body.action === "context") {
    // The presenter's lens: re-rank the open case in place. Prices and approvals are untouched.
    const memory = await session.memory();
    await session.update((s) => {
      s.contextMode = body.mode;
      if (s.repairCase && !s.rebook) rerank(s, memory);
    });
    return Response.json({ ok: true, mode: body.mode });
  }
  if (body.action === "learner") {
    // The learner switch: whether what was learned is used. Re-ranks an open case in place, like the lens.
    const memory = await session.memory();
    await session.update((s) => {
      s.learner = body.on;
      if (s.repairCase && !s.rebook) rerank(s, memory);
    });
    return Response.json({ ok: true, learner: body.on });
  }
  if (body.action === "reset-trip") await session.resetTrip();
  if (body.action === "reset-all") await session.resetAll();
  if (body.action === "next-trip") await session.nextTrip();
  if (body.action === "storm") {
    await session.update((s) => void (s.storm = true));
    return Response.json({ ok: true, message: "Weather alert: a storm is moving over Chicago O'Hare this evening." });
  }
  return Response.json({ ok: true });
}
