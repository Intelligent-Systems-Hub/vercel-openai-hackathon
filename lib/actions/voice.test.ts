import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore, Session } from "@/lib/state";

import { followCall, incomingCall, verifyWebhook, WebhookSignatureError, type Socket } from "./voice";

const SECRET = `whsec_${Buffer.from("test-signing-key").toString("base64")}`;

function signed(body: string, at = Math.floor(Date.now() / 1000), secret = SECRET) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`msg_1.${at}.${body}`).digest("base64");
  return new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(at), "webhook-signature": `v1,${sig}` });
}

const incoming = (sessionId = "s-call") =>
  JSON.stringify({
    type: "realtime.call.incoming",
    data: { call_id: "rtc_1", sip_headers: [{ name: "From", value: "sip:+15550199" }, { name: "X-Trip-Session", value: sessionId }] },
  });

describe("voice webhook", () => {
  it("accepts only OpenAI-signed, fresh webhooks", () => {
    const body = incoming();
    expect(() => verifyWebhook(body, signed(body), SECRET)).not.toThrow();
    expect(() => verifyWebhook(body, signed(body), undefined)).toThrow(WebhookSignatureError);
    expect(() => verifyWebhook(`${body} `, signed(body), SECRET)).toThrow(/bad signature/);
    expect(() => verifyWebhook(body, signed(body, Math.floor(Date.now() / 1000) - 3600), SECRET)).toThrow(/stale/);
    expect(() => verifyWebhook(body, signed(body, undefined, `whsec_${Buffer.from("other").toString("base64")}`), SECRET)).toThrow(/bad signature/);
  });

  it("reads the call id and our session from the SIP headers", () => {
    expect(incomingCall(JSON.parse(incoming("s 1")))).toEqual({ callId: "rtc_1", sessionId: "s 1" });
    expect(incomingCall({ type: "realtime.call.incoming", data: { call_id: "rtc_2", sip_headers: { "x-trip-session": "abc" } } })).toEqual({ callId: "rtc_2", sessionId: "abc" });
    expect(incomingCall({ type: "response.done" })).toBeUndefined();
  });
});

class FakeSocket implements Socket {
  sent: unknown[] = [];
  closed = false;
  private listeners: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  async emit(type: string, data?: unknown) {
    for (const fn of this.listeners[type] ?? []) await fn({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
}

afterEach(() => vi.useRealTimers());

describe("following the live call", () => {
  it("starts the agent talking, records both sides and the hotel's answer, then hangs up", async () => {
    const session = new Session("s-call", new MemoryStore(), "2026-09-29");
    await session.update((s) => {
      s.refund = { route: "call", hotel: "Delta Calgary Airport", amountCents: 21365, framing: "…", to: "•••0100", sent: true, callSid: "CA1", transcript: [] };
    });
    const socket = new FakeSocket();
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    let url = "";
    const followed = followCall("rtc_1", session, {
      env: { OPENAI_API_KEY: "k" },
      socket: (u) => ((url = u), socket),
      fetcher,
      goodbyeMs: 1,
    });

    expect(url).toBe("wss://api.openai.com/v1/realtime?call_id=rtc_1");
    await socket.emit("open");
    expect(socket.sent).toEqual([{ type: "response.create" }]);
    await socket.emit("message", { type: "response.output_audio_transcript.done", transcript: "Hi, I'm an AI assistant calling for your guests." });
    await socket.emit("message", { type: "conversation.item.input_audio_transcription.completed", transcript: "I'll send it to the manager." });
    await socket.emit("message", {
      type: "response.function_call_arguments.done",
      name: "record_outcome",
      call_id: "fc_1",
      arguments: JSON.stringify({ outcome: "under review", note: "manager decides tomorrow" }),
    });
    await followed;

    const refund = (await session.state()).refund!;
    expect(refund.transcript).toEqual([
      { who: "agent", text: "Hi, I'm an AI assistant calling for your guests." },
      { who: "hotel", text: "I'll send it to the manager." },
    ]);
    expect(refund.outcome).toBe("under review: manager decides tomorrow");
    expect(socket.sent).toContainEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "fc_1", output: "recorded" } });
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls/rtc_1/hangup", expect.objectContaining({ method: "POST" }));
    expect(socket.closed).toBe(true);
  });

  it("never outlives its time limit", async () => {
    const session = new Session("s-limit", new MemoryStore(), "2026-09-29");
    const socket = new FakeSocket();
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    await followCall("rtc_9", session, { env: {}, socket: () => socket, fetcher, limitMs: 5 });
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls/rtc_9/hangup", expect.anything());
    expect(socket.closed).toBe(true);
  });
});
