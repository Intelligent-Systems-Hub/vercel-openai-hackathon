import { createHmac, timingSafeEqual } from "node:crypto";

import type { Session } from "@/lib/state";

import type { CallLine } from "./call";

// The live hotel call, on OpenAI's side. Twilio has dialled the team phone
// and bridged it to the project's Realtime SIP endpoint; OpenAI then posts a
// `realtime.call.incoming` webhook here. We accept only a call this demo
// placed (its session id rides in a SIP header, and that session must be
// waiting on a call), with the brief the agent wrote from the booking. A
// sideband connection to the same call records both sides of the transcript
// and the hotel's answer into the session, where the phone UI reads it.

type Env = Record<string, string | undefined>;

const API = "https://api.openai.com/v1/realtime/calls";

export class WebhookSignatureError extends Error {}

/**
 * Verify an OpenAI webhook (the Standard Webhooks scheme): HMAC-SHA256 over
 * "id.timestamp.body" with the base64 secret after "whsec_", compared against
 * each "v1,<sig>" in the header, and a timestamp within five minutes.
 */
export function verifyWebhook(body: string, headers: Headers, secret: string | undefined, now = Date.now()): void {
  if (!secret) throw new WebhookSignatureError("OPENAI_WEBHOOK_SECRET is not set");
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) throw new WebhookSignatureError("missing webhook headers");
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) throw new WebhookSignatureError("stale webhook");
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  const ok = signatures.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    const got = Buffer.from(sig ?? "", "base64");
    return version === "v1" && got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new WebhookSignatureError("bad signature");
}

export type IncomingCall = { callId: string; sessionId?: string };

type SipHeader = { name: string; value: string };

/** The call id and our session id (the X-Trip-Session SIP header) from an incoming-call event. */
export function incomingCall(event: { type?: string; data?: { call_id?: string; sip_headers?: SipHeader[] | Record<string, string> } }): IncomingCall | undefined {
  if (event.type !== "realtime.call.incoming" || !event.data?.call_id) return undefined;
  const raw = event.data.sip_headers ?? [];
  const headers = Array.isArray(raw) ? raw : Object.entries(raw).map(([name, value]) => ({ name, value }));
  const session = headers.find((h) => h.name.toLowerCase() === "x-trip-session")?.value;
  return { callId: event.data.call_id, sessionId: session && decodeURIComponent(session) };
}

const RECORD_OUTCOME = {
  type: "function",
  name: "record_outcome",
  description: "Record the hotel's answer to the refund request.",
  parameters: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["approved", "declined", "under review"] },
      note: { type: "string", description: "Anything the hotel said about it, in a few words" },
    },
    required: ["outcome"],
  },
};

function auth(env: Env) {
  return { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" };
}

export async function acceptCall(callId: string, instructions: string, env: Env = process.env, fetcher: typeof fetch = fetch) {
  const res = await fetcher(`${API}/${callId}/accept`, {
    method: "POST",
    headers: auth(env),
    body: JSON.stringify({
      type: "realtime",
      model: env.REALTIME_MODEL ?? "gpt-realtime",
      instructions,
      audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } }, output: { voice: env.REALTIME_VOICE ?? "marin" } },
      tools: [RECORD_OUTCOME],
    }),
  });
  if (!res.ok) throw new Error(`accept answered ${res.status}`);
}

export async function rejectCall(callId: string, env: Env = process.env, fetcher: typeof fetch = fetch) {
  await fetcher(`${API}/${callId}/reject`, { method: "POST", headers: auth(env), body: JSON.stringify({ status_code: 603 }) });
}

export async function hangUp(callId: string, env: Env = process.env, fetcher: typeof fetch = fetch) {
  await fetcher(`${API}/${callId}/hangup`, { method: "POST", headers: auth(env) });
}

/** The smallest WebSocket surface the sideband needs, so tests can stand in for it. */
export type Socket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (e: { data?: unknown }) => void): void;
};

export type SocketFactory = (url: string, headers: Record<string, string>) => Socket;

// Node's WebSocket (undici) takes request headers in its second argument.
const nodeSocket: SocketFactory = (url, headers) =>
  new (WebSocket as unknown as new (u: string, init: { headers: Record<string, string> }) => Socket)(url, { headers });

/**
 * Follow the call over its sideband connection until it ends: start the
 * agent talking, write each finished line of speech to the session, record
 * the hotel's answer when the agent calls record_outcome, then hang up.
 */
export function followCall(
  callId: string,
  session: Session,
  opts: { env?: Env; socket?: SocketFactory; fetcher?: typeof fetch; limitMs?: number; goodbyeMs?: number } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const ws = (opts.socket ?? nodeSocket)(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
    authorization: `Bearer ${env.OPENAI_API_KEY}`,
  });
  const say = (line: CallLine) =>
    session.update((s) => {
      if (s.refund) s.refund.transcript = [...(s.refund.transcript ?? []), line];
    });

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve();
    };
    // Never outlive the function: the route's maxDuration bounds this.
    const limit = setTimeout(async () => {
      await hangUp(callId, env, opts.fetcher).catch(() => undefined);
      finish();
    }, opts.limitMs ?? 240_000);

    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "response.create" })));
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);
    ws.addEventListener("message", async (e) => {
      const event = JSON.parse(String(e.data)) as Record<string, string>;
      if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript?.trim()) {
        await say({ who: "hotel", text: event.transcript.trim() });
      } else if (event.type === "response.output_audio_transcript.done" && event.transcript?.trim()) {
        await say({ who: "agent", text: event.transcript.trim() });
      } else if (event.type === "response.function_call_arguments.done" && event.name === "record_outcome") {
        const { outcome, note } = JSON.parse(event.arguments || "{}") as { outcome?: string; note?: string };
        await session.update((s) => {
          if (s.refund) s.refund.outcome = [outcome, note].filter(Boolean).join(": ");
        });
        ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: event.call_id, output: "recorded" } }));
        ws.send(JSON.stringify({ type: "response.create" }));
        // Let the agent say thank you and goodbye, then end the call.
        setTimeout(async () => {
          await hangUp(callId, env, opts.fetcher).catch(() => undefined);
          finish();
        }, opts.goodbyeMs ?? 8_000);
      }
    });
  });
}
