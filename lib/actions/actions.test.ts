import { describe, expect, it, vi } from "vitest";

import { buildSeedTrip } from "@/lib/domain/seed";

import { itineraryText, tripCalendar } from "./calendar";
import { liveCalls, placeCall } from "./call";
import { emailTo, mask, NotAllowedError, notify } from "./notify";

const trip = buildSeedTrip("2026-09-29");
const message = itineraryText(trip);

/** Minimal RFC 5545 reader: the VEVENT blocks as key -> value maps. */
function events(ics: string) {
  return ics
    .split("\r\n")
    .join("\n")
    .split("BEGIN:VEVENT\n")
    .slice(1)
    .map((block) =>
      Object.fromEntries(
        block
          .split("\n")
          .filter((l) => l.includes(":") && !l.startsWith("END:"))
          .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]),
      ),
    );
}

describe("calendar (S8)", () => {
  const ics = tripCalendar(trip, new Date("2026-09-28T12:00:00Z"));

  it("is a well-formed calendar with one event per flight", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(4);
    expect(ics.match(/END:VEVENT/g)).toHaveLength(4);
    expect(ics.split("\r\n").every((l) => !l.includes("\n"))).toBe(true);
  });

  it("carries each flight at its local times", () => {
    const [first, onward] = events(ics);
    expect(first).toMatchObject({ DTSTART: "20260929T135900", DTEND: "20260929T155300", SUMMARY: "AA 3321 JFK → ORD" });
    expect(onward).toMatchObject({ DTSTART: "20260929T173000", SUMMARY: "WS 1611 ORD → YYC" });
    expect(first.UID).toMatch(/^QKRVTB-AA3321-2026-09-29@/);
  });

  it("writes the itinerary as plain text for the email", () => {
    expect(message.subject).toBe("Your trip is rebooked: QKRVTB");
    expect(message.text).toContain("WS 1611  ORD→YYC  2026-09-29 17:30–20:19");
  });
});

describe("notify (S8)", () => {
  const env = {
    NOTIFY_EMAIL: "maya@example.com",
    NOTIFY_ALLOWLIST: "maya@example.com, +15550100",
    RESEND_API_KEY: "re_test",
  };

  it("sends nothing while live actions are off", async () => {
    const fetcher = vi.fn();
    const result = await notify("email", message, env, fetcher as unknown as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: false, reason: "live actions are off", to: "m***@example.com" });
  });

  it("refuses a recipient that is not on the allowlist, live or not", async () => {
    const fetcher = vi.fn();
    const outsider = { ...env, NOTIFY_EMAIL: "someone@else.com", LIVE_ACTIONS: "on" };
    await expect(notify("email", message, outsider, fetcher as unknown as typeof fetch)).rejects.toThrow(NotAllowedError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the email through the provider when live", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    const result = await notify("email", message, { ...env, LIVE_ACTIONS: "on" }, fetcher as unknown as typeof fetch);
    expect(result).toEqual({ channel: "email", to: "m***@example.com", sent: true, providerId: "em_1" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(init.body))).toMatchObject({ to: ["maya@example.com"], subject: message.subject });
  });

  it("reports a missing recipient instead of guessing one", async () => {
    expect(await notify("sms", message, env)).toMatchObject({ sent: false, reason: "no sms recipient is configured" });
  });

  it("masks addresses and numbers", () => {
    expect(mask("maya@example.com")).toBe("m***@example.com");
    expect(mask("+15551234567")).toBe("•••4567");
  });
});

describe("hotel email and call guards (R2)", () => {
  const hotel = { subject: "Refund request", text: "…" };
  const env = { HOTEL_EMAIL: "hotel@team.example", NOTIFY_ALLOWLIST: "hotel@team.example,+15550100" };

  it("emails the hotel only at an allowlisted address, and only when live actions are on", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    await expect(emailTo("someone@else.example", hotel, env, fetcher)).rejects.toThrow(NotAllowedError);
    expect(await emailTo(env.HOTEL_EMAIL, hotel, env, fetcher)).toMatchObject({ sent: false, reason: "live actions are off" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await emailTo(env.HOTEL_EMAIL, hotel, { ...env, LIVE_ACTIONS: "on", RESEND_API_KEY: "k" }, fetcher)).toMatchObject({
      sent: true,
      to: "h***@team.example",
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).to).toEqual([env.HOTEL_EMAIL]);
  });

  it("places a real call only with live actions AND live calls on, to an allowlisted number, bridged to the Realtime SIP endpoint", async () => {
    expect(liveCalls({ LIVE_ACTIONS: "on" })).toBe(false);
    expect(liveCalls({ LIVE_CALLS: "on" })).toBe(false);
    expect(liveCalls({ LIVE_ACTIONS: "on", LIVE_CALLS: "on" })).toBe(true);

    const callEnv = { ...env, TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+15550199", OPENAI_PROJECT_ID: "proj_1" };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ sid: "CA1" }), { status: 201 }));
    await expect(placeCall("s-1", { ...callEnv, HOTEL_PHONE: "+15550111" }, fetcher)).rejects.toThrow(NotAllowedError);
    expect(fetcher).not.toHaveBeenCalled();

    expect(await placeCall("s 1", { ...callEnv, HOTEL_PHONE: "+15550100" }, fetcher)).toEqual({ callSid: "CA1", to: "•••0100" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("To")).toBe("+15550100");
    expect(form.get("Twiml")).toBe(
      "<Response><Dial><Sip>sip:proj_1@sip.api.openai.com;transport=tls?X-Trip-Session=s%201</Sip></Dial></Response>",
    );
  });
});
