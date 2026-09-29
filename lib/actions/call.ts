import type { RefundAsk } from "@/lib/domain/policy";

import { liveActions, mask, NotAllowedError, onAllowlist } from "./notify";

// Calling the hotel on the traveler's behalf. The real call is an outbound
// Twilio call to the hotel number on file, which in the demo is an
// allowlisted team phone, bridged to OpenAI's Realtime SIP endpoint; our
// webhook (/api/voice/incoming) accepts it with the agent's instructions and
// records the transcript. It needs LIVE_ACTIONS and LIVE_CALLS both on.
// Otherwise the call is simulated, and every line of it says so.

type Env = Record<string, string | undefined>;

export type CallLine = { who: "agent" | "hotel"; text: string };

export type CallResult = {
  to: string;
  placed: boolean;
  simulated: boolean;
  /** Twilio's call id, for a real call. */
  callSid?: string;
  /** For a simulated call, the whole conversation; a real one fills in as it happens. */
  transcript: CallLine[];
  reason?: string;
};

export const liveCalls = (env: Env = process.env) => liveActions(env) && env.LIVE_CALLS === "on";

export function callConfigured(env: Env = process.env): boolean {
  return Boolean(env.HOTEL_PHONE && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && env.OPENAI_PROJECT_ID);
}

/** What the agent says on the call: who it is, why it's calling, and exactly what it asks. */
export function callInstructions(ask: RefundAsk, guests: string, delay: string): string {
  return `You are a travel concierge phoning ${ask.hotel} on behalf of your guests ${guests}, who were due to check in on ${ask.night}.
${delay}
Ask whether the hotel will refund the first night, $${(ask.amountCents / 100).toFixed(2)}, because of the flight disruption. The rest of the stay is unchanged.
Say at the start that you are an AI assistant calling for the guests. Be brief and polite. Do not agree to any charge, change or new booking, and do not share any payment details.
When the hotel gives an answer (approved, declined, or they will review it), call record_outcome with it, thank them, and say goodbye.`;
}

/** A labelled stand-in for the call, so the demo runs without phones. */
export function simulatedCall(ask: RefundAsk, guests: string): CallLine[] {
  const amount = `$${(ask.amountCents / 100).toFixed(2)}`;
  return [
    { who: "hotel", text: `[simulated] ${ask.hotel}, front desk.` },
    { who: "agent", text: `[simulated] Hi, I'm an AI assistant calling for your guests ${guests}, checking in ${ask.night}. A storm broke their connection and they'll arrive a night late. Could you refund the first night, ${amount}?` },
    { who: "hotel", text: "[simulated] The rate is non-refundable, but for a documented flight disruption I can send it to our manager to review." },
    { who: "agent", text: "[simulated] Thank you. Please do. I'll let them know it's requested and under review." },
  ];
}

export async function placeCall(
  sessionId: string,
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
): Promise<{ callSid: string; to: string }> {
  const to = env.HOTEL_PHONE!;
  if (!onAllowlist(to, env)) throw new NotAllowedError(`${mask(to)} is not on NOTIFY_ALLOWLIST`);
  const sid = env.TWILIO_ACCOUNT_SID!;
  // When the callee answers, Twilio bridges them to the project's Realtime SIP endpoint, carrying the session id.
  const sip = `sip:${env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-Trip-Session=${encodeURIComponent(sessionId)}`;
  const twiml = `<Response><Dial><Sip>${sip.replaceAll("&", "&amp;")}</Sip></Dial></Response>`;
  const res = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: env.TWILIO_FROM!, Twiml: twiml }),
  });
  if (!res.ok) throw new Error(`call provider answered ${res.status}`);
  return { callSid: String(((await res.json()) as { sid?: string }).sid ?? ""), to: mask(to) };
}
