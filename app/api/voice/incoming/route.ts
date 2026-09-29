import { after } from "next/server";

import { liveCalls } from "@/lib/actions/call";
import { acceptCall, followCall, incomingCall, rejectCall, verifyWebhook, WebhookSignatureError } from "@/lib/actions/voice";
import { getStore, Session } from "@/lib/state";

// OpenAI's webhook for incoming Realtime SIP calls. The only calls this
// accepts are the ones the agent placed to the hotel: signed by OpenAI, for a
// session that is waiting on a call it dialled, with live calls on. The
// sideband that records the transcript runs after the response, within this
// route's maxDuration.

export const maxDuration = 300;

export async function POST(req: Request) {
  const body = await req.text();
  try {
    verifyWebhook(body, req.headers, process.env.OPENAI_WEBHOOK_SECRET);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }

  const call = incomingCall(JSON.parse(body));
  if (!call) return Response.json({ ok: true, ignored: true });

  const session = call.sessionId ? new Session(call.sessionId, getStore()) : undefined;
  const state = session && (await session.state());
  const expected = state?.refund?.route === "call" && state.refund.callSid && !state.refund.outcome && state.callBrief;
  if (!liveCalls() || !session || !expected) {
    await rejectCall(call.callId);
    return Response.json({ ok: true, rejected: true });
  }

  await acceptCall(call.callId, state.callBrief!);
  after(() => followCall(call.callId, session));
  return Response.json({ ok: true, accepted: true });
}
