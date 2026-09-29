// Telling the traveler about the new itinerary: the one action in the demo
// that leaves the building for real. Three guards, all server-side:
//   - LIVE_ACTIONS must be "on"; otherwise the message is composed and logged only.
//   - The recipient comes from server config (NOTIFY_EMAIL / NOTIFY_SMS), never
//     from the model, and must be on NOTIFY_ALLOWLIST.
//   - One send per channel per rebook (enforced by the caller's state).

type Env = Record<string, string | undefined>;

export type Channel = "email" | "sms";

export type NotifyResult = {
  channel: Channel;
  to: string;
  sent: boolean;
  /** Why nothing was sent, when it was not. */
  reason?: string;
  providerId?: string;
};

export class NotAllowedError extends Error {}

export const liveActions = (env: Env = process.env) => env.LIVE_ACTIONS === "on";

export function onAllowlist(to: string, env: Env = process.env): boolean {
  return allowlist(env).has(to.toLowerCase());
}

function allowlist(env: Env): Set<string> {
  return new Set(
    (env.NOTIFY_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function recipient(channel: Channel, env: Env = process.env): string | undefined {
  return channel === "email" ? env.NOTIFY_EMAIL : env.NOTIFY_SMS;
}

/** "maya@example.com" -> "m***@example.com"; "+15551234567" -> "•••4567". */
export function mask(to: string): string {
  if (to.includes("@")) {
    const [user, domain] = to.split("@");
    return `${user[0] ?? ""}***@${domain}`;
  }
  return `•••${to.slice(-4)}`;
}

async function sendEmail(to: string, subject: string, text: string, env: Env, fetcher: typeof fetch) {
  const res = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.NOTIFY_FROM ?? "Trip Repair Agent <onboarding@resend.dev>", to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`email provider answered ${res.status}`);
  return String(((await res.json()) as { id?: string }).id ?? "");
}

async function sendSms(to: string, text: string, env: Env, fetcher: typeof fetch) {
  const sid = env.TWILIO_ACCOUNT_SID ?? "";
  const res = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN ?? ""}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: env.TWILIO_FROM ?? "", Body: text }),
  });
  if (!res.ok) throw new Error(`SMS provider answered ${res.status}`);
  return String(((await res.json()) as { sid?: string }).sid ?? "");
}

/**
 * Email a configured address that isn't the traveler's (the hotel's inbox on
 * file). Same guards: the address comes from server config, must be on the
 * allowlist, and nothing leaves unless live actions are on.
 */
export async function emailTo(
  to: string | undefined,
  message: { subject: string; text: string },
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
): Promise<NotifyResult> {
  if (!to) return { channel: "email", to: "", sent: false, reason: "no address is configured" };
  if (!onAllowlist(to, env)) throw new NotAllowedError(`${mask(to)} is not on NOTIFY_ALLOWLIST`);
  if (!liveActions(env)) {
    console.info(`[email] live actions off; would send to ${mask(to)}: ${message.subject}`);
    return { channel: "email", to: mask(to), sent: false, reason: "live actions are off" };
  }
  return { channel: "email", to: mask(to), sent: true, providerId: await sendEmail(to, message.subject, message.text, env, fetcher) };
}

export async function notify(
  channel: Channel,
  message: { subject: string; text: string },
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
): Promise<NotifyResult> {
  const to = recipient(channel, env);
  if (!to) return { channel, to: "", sent: false, reason: `no ${channel} recipient is configured` };
  if (!allowlist(env).has(to.toLowerCase())) {
    throw new NotAllowedError(`${mask(to)} is not on NOTIFY_ALLOWLIST`);
  }
  if (!liveActions(env)) {
    console.info(`[notify:${channel}] live actions off; would send to ${mask(to)}: ${message.subject}`);
    return { channel, to: mask(to), sent: false, reason: "live actions are off" };
  }
  const providerId =
    channel === "email"
      ? await sendEmail(to, message.subject, message.text, env, fetcher)
      : await sendSms(to, message.text, env, fetcher);
  return { channel, to: mask(to), sent: true, providerId };
}
