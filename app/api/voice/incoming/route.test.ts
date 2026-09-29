import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStore, Session } from "@/lib/state";

const calls = vi.hoisted(() => ({ accept: vi.fn(), reject: vi.fn(), follow: vi.fn(), after: vi.fn() }));

vi.mock("next/server", () => ({ after: calls.after }));
vi.mock("@/lib/actions/voice", async (real) => ({
  ...(await real<typeof import("@/lib/actions/voice")>()),
  acceptCall: calls.accept,
  rejectCall: calls.reject,
  followCall: calls.follow,
}));

const { POST } = await import("./route");

const SECRET = `whsec_${Buffer.from("route-test-key").toString("base64")}`;

function webhook(sessionId: string, secret = SECRET) {
  const body = JSON.stringify({
    type: "realtime.call.incoming",
    data: { call_id: "rtc_7", sip_headers: [{ name: "X-Trip-Session", value: sessionId }] },
  });
  const at = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`msg_7.${at}.${body}`).digest("base64");
  return new Request("http://test/api/voice/incoming", {
    method: "POST",
    body,
    headers: { "webhook-id": "msg_7", "webhook-timestamp": String(at), "webhook-signature": `v1,${sig}` },
  });
}

async function waitingOnCall(sessionId: string) {
  await new Session(sessionId, getStore()).update((s) => {
    s.refund = { route: "call", hotel: "Delta Calgary Airport", amountCents: 21365, framing: "…", to: "•••0100", sent: true, callSid: "CA7", transcript: [] };
    s.callBrief = "You are a travel concierge phoning Delta Calgary Airport…";
  });
}

beforeEach(() => {
  vi.stubEnv("OPENAI_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("LIVE_ACTIONS", "on");
  vi.stubEnv("LIVE_CALLS", "on");
  Object.values(calls).forEach((f) => f.mockReset());
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/voice/incoming", () => {
  it("refuses an unsigned webhook", async () => {
    const res = await POST(webhook("s-x", `whsec_${Buffer.from("forged").toString("base64")}`));
    expect(res.status).toBe(400);
    expect(calls.accept).not.toHaveBeenCalled();
  });

  it("rejects a call no session placed", async () => {
    const res = await POST(webhook(`voice-none-${Date.now()}`));
    expect(await res.json()).toMatchObject({ rejected: true });
    expect(calls.reject).toHaveBeenCalledWith("rtc_7");
    expect(calls.accept).not.toHaveBeenCalled();
  });

  it("rejects even a placed call when live calls are off", async () => {
    const id = `voice-off-${Date.now()}`;
    await waitingOnCall(id);
    vi.stubEnv("LIVE_CALLS", "");
    expect(await (await POST(webhook(id))).json()).toMatchObject({ rejected: true });
  });

  it("accepts the call the agent placed, with its brief, and follows it after responding", async () => {
    const id = `voice-ok-${Date.now()}`;
    await waitingOnCall(id);
    const res = await POST(webhook(id));
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(calls.accept).toHaveBeenCalledWith("rtc_7", "You are a travel concierge phoning Delta Calgary Airport…");
    expect(calls.after).toHaveBeenCalledTimes(1);
    await calls.after.mock.calls[0][0]();
    expect(calls.follow).toHaveBeenCalledWith("rtc_7", expect.objectContaining({ id }));
  });
});
