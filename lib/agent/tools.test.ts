import { describe, expect, it } from "vitest";

import { getStore, MemoryStore, redisConfig, Session, StateConfigError } from "@/lib/state";

import { approvalRules, makeTools } from "./tools";

const DEMO = "2026-09-29";

function setup() {
  const session = new Session("s-1", new MemoryStore(), DEMO);
  const tools = makeTools(session);
  const storm = () => session.update((s) => void (s.storm = true));
  // Calls a tool's execute the way the SDK does, without a model.
  const call = async <K extends keyof typeof tools>(name: K, input: Record<string, unknown> = {}) => {
    const t = tools[name] as unknown as { execute: (i: unknown, o: unknown) => unknown };
    return (await t.execute(input, { toolCallId: `call-${name}`, messages: [] })) as Record<string, unknown>;
  };
  return { session, tools, call, storm };
}

type OptionOut = { id: string; price: string; reasoning?: { headline: string } };
const options = (res: Record<string, unknown>) => res.options as OptionOut[];

describe("agent tools", () => {
  it("detects the storm and ranks the same-day connection first with no memory (S1, S2)", async () => {
    const { call, storm } = setup();
    expect(await call("check_disruption")).toMatchObject({ disrupted: false, reason: "no high-risk weather alert" });
    await storm();
    const detected = await call("check_disruption");
    expect(detected).toMatchObject({ disrupted: true, case: { hub: "ORD", connectionLeftMinutes: 7 } });
    const found = await call("find_rebooking_options");
    expect(found.usedWhatYouKnow).toBe(false);
    expect(options(found).map((o) => o.id)).toEqual(["later-connection", "overnight-at-hub"]);
    expect((found.supplierCalls as { match: string }[]).every((c) => c.match === "exact")).toBe(true);
  });

  it("with the booking alone, offers only its top pick; with context, the alternatives too", async () => {
    const { call, session, storm } = setup();
    await session.update((s) => void (s.contextMode = "booking"));
    await storm();
    await call("check_disruption");
    expect(options(await call("find_rebooking_options")).map((o) => o.id)).toEqual(["later-connection"]);
    expect(options(await call("present_options")).map((o) => o.id)).toEqual(["later-connection"]);
    // Both are still ranked and priced; only what is offered changes
    expect((await session.state()).options?.map((o) => o.id)).toEqual(["later-connection", "overnight-at-hub"]);
    await session.update((s) => void (s.contextMode = "context"));
    expect(options(await call("present_options")).map((o) => o.id)).toEqual(["later-connection", "overnight-at-hub"]);
  });

  it("being told about the baby does not re-rank on its own (L1)", async () => {
    const { call, storm } = setup();
    await storm();
    await call("check_disruption");
    await call("remember_traveler", { kind: "travels_with_infant", text: "we have a baby" });
    const found = await call("find_rebooking_options");
    expect(found.usedWhatYouKnow).toBe(false);
    expect(options(found)[0].id).toBe("later-connection");
  });

  it("learns from a choice against the recommendation, and uses it on the next trip (L2, L3)", async () => {
    const { call, session, storm } = setup();
    await storm();
    await call("check_disruption");
    await call("find_rebooking_options");
    // Taking the recommendation teaches nothing.
    expect(await call("learn_from_choice", { optionId: "later-connection", reason: "fine" })).toMatchObject({ learned: false });
    const learned = await call("learn_from_choice", { optionId: "overnight-at-hub", reason: "Nora needs a real night's sleep" });
    expect(learned).toMatchObject({ learned: true, chose: "overnight-at-hub", over: "later-connection", graph: expect.stringMatching(/tied to Nora/) });
    expect((await session.memory()).facts).toEqual([
      { kind: "learned_choice", text: "Nora needs a real night's sleep", chose: "overnight-at-hub", over: "later-connection", childName: "Nora" },
    ]);
    // This trip's ranking is unchanged; the next trip leads with the overnight.
    expect((await session.state()).options?.[0].id).toBe("later-connection");

    await session.nextTrip();
    const next = await session.state();
    expect(next.trip).toMatchObject({ id: "trip-2", hotel: { name: "Delta Calgary Airport" } });
    await storm();
    await call("check_disruption");
    // Learner off: written down, not used
    const dormant = await call("find_rebooking_options");
    expect(dormant).toMatchObject({ usedWhatYouKnow: false, learner: "off" });
    expect(options(dormant)[0].id).toBe("later-connection");
    // Learner on: the learned choice leads
    await session.update((s) => void (s.learner = true));
    const found = await call("find_rebooking_options");
    expect(found.usedWhatYouKnow).toBe(true);
    const [top] = options(found);
    expect(top).toMatchObject({ id: "overnight-at-hub" });
    expect(top.reasoning?.headline).toBe("Last time you chose a night's stop for Nora");
    expect((found.supplierCalls as { match: string }[]).every((c) => c.match === "exact")).toBe(true);
  });

  it("asks for approval at the server's price, and refuses options that cannot be priced", async () => {
    const { call, session, storm } = setup();
    const rules = approvalRules(session) as Record<string, (i: unknown) => Promise<unknown>>;
    expect(await rules.request_approval({ optionId: "overnight-at-hub" })).toMatchObject({ type: "denied" });
    await storm();
    await call("check_disruption");
    await call("find_rebooking_options");
    expect(await rules.request_approval({ optionId: "overnight-at-hub" })).toEqual({
      type: "user-approval",
      reason: "Overnight at ORD, first flight out tomorrow: $401.79",
    });
  });

  it("books only with an approval id, uses each approval once, and settles once (S5, S6, S7)", async () => {
    const { call, storm } = setup();
    await storm();
    await call("check_disruption");
    await call("find_rebooking_options");

    expect(await call("execute_rebook", { approvalId: "ap-made-up" })).toMatchObject({ refused: true });
    expect(await call("settle_payment", { approvalId: "ap-made-up" })).toMatchObject({ refused: true });

    const approved = await call("request_approval", { optionId: "overnight-at-hub" });
    expect(approved).toMatchObject({ approved: true, amount: "$401.79" });
    const approvalId = approved.approvalId as string;

    const booked = await call("execute_rebook", { approvalId });
    expect(booked).toMatchObject({ outcome: "rebooked", oldBooking: "cancelled", newBookingCode: "QKRVTA" });
    expect((booked.steps as { step: string }[]).map((s) => s.step)).toEqual([
      "getBooking",
      "checkFlightTickets",
      "createBooking",
      "fulfillFlightTickets",
      "cancelBooking",
      "getBooking",
    ]);
    expect(await call("execute_rebook", { approvalId })).toMatchObject({ error: expect.stringMatching(/already/) });

    const paid = await call("settle_payment", { approvalId });
    expect(paid).toMatchObject({ kind: "charge", amount: "$401.79", alreadySettled: false });
    expect(await call("settle_payment", { approvalId })).toMatchObject({ alreadySettled: true });

    // S8: the itinerary goes out once, logged only while live actions are off; the calendar is offered
    const sent = await call("notify_traveler", { channel: "email" });
    expect(sent).toMatchObject({ channel: "email", sent: false });
    expect(await call("notify_traveler", { channel: "email" })).toMatchObject({ reason: "already sent" });
    expect(await call("add_to_calendar")).toMatchObject({ url: "/api/calendar?sessionId=s-1" });

    const trip = await call("get_trip");
    expect(trip.bookingCode).toBe("QKRVTA");
    expect((trip.flights as string[])[1]).toMatch(/^UA 764 ORD→YYC/);
  });

  it("refuses an approval whose option's price changed after the traveler approved it", async () => {
    const { call, session, storm } = setup();
    await storm();
    await call("check_disruption");
    await call("find_rebooking_options");
    const { approvalId } = await call("request_approval", { optionId: "overnight-at-hub" });
    await session.update((s) => {
      s.options = s.options!.map((o) => (o.id === "overnight-at-hub" ? { ...o, priceDelta: 999 } : o));
    });
    expect(await call("execute_rebook", { approvalId })).toMatchObject({
      refused: true,
      reason: expect.stringMatching(/price changed/),
    });
  });

  it("sends nothing and offers no calendar before a rebook", async () => {
    const { call } = setup();
    expect(await call("notify_traveler", { channel: "email" })).toMatchObject({ refused: true });
    expect(await call("add_to_calendar")).toMatchObject({ refused: true });
  });

  it("tells the model which facts it used, with paths, and which it must not use (G1, G2)", async () => {
    const { call, session, storm } = setup();
    await storm();
    await call("check_disruption");
    await session.saveMemory({
      facts: [{ kind: "learned_choice", text: "a real night's sleep", chose: "overnight-at-hub", over: "later-connection" }],
    });
    await session.update((s) => void (s.learner = true));
    const found = await call("find_rebooking_options");
    const context = found.context as { coverage: string; used: { fact: string; path: string }[]; notUsed: { fact: string; why: string }[] };
    expect(context.coverage).toBe("complete");
    expect(context.used.find((u) => u.fact === "Nora (infant)")?.path).toBe("Storm at ORD → WS 1611 ORD→YYC → Booking QKRVTB → Banff trip → Party of 3 → Nora (infant)");
    expect(context.notUsed).toContainEqual({ fact: "Gold member", why: expect.stringMatching(/cash-only/) });
  });

  it("shops the trip's own dates even when the session was started on another day", async () => {
    // Seeded for a departure that is not tomorrow; the tools get no date and must read it from the trip.
    const session = new Session("s-old", new MemoryStore(), "2026-09-29");
    await session.update((s) => void (s.storm = true));
    const tools = makeTools(session) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }>;
    const opts = { toolCallId: "t", messages: [] };
    await tools.check_disruption.execute({}, opts);
    const found = await tools.find_rebooking_options.execute({}, opts);
    expect((found.supplierCalls as { match: string }[]).every((c) => c.match === "exact")).toBe(true);
    expect((found.options as { id: string }[]).map((o) => o.id)).toEqual(["later-connection", "overnight-at-hub"]);
  });

  it("asks the traveler before requesting a refund, and writes their yes back with its reason (items 4, 5)", async () => {
    const { call, session, storm } = setup();
    const rules = approvalRules(session) as Record<string, (i: unknown) => Promise<unknown>>;
    await session.saveMemory({
      facts: [{ kind: "learned_choice", text: "Nora needs a real night's sleep", chose: "overnight-at-hub", over: "later-connection", childName: "Nora" }],
    });
    await storm();
    await call("check_disruption");
    await call("find_rebooking_options");
    expect(await rules.email_hotel({})).toMatchObject({ type: "denied" });
    // Learner off: the rebook approval covers the rebook only
    expect(await rules.request_approval({ optionId: "overnight-at-hub" })).toEqual({
      type: "user-approval",
      reason: "Overnight at ORD, first flight out tomorrow: $401.79",
    });
    const { approvalId } = await call("request_approval", { optionId: "overnight-at-hub" });
    await call("execute_rebook", { approvalId });
    await call("check_hotel_policy");
    expect(await rules.email_hotel({})).toEqual({ type: "user-approval", reason: "Refund request · Bow River Lodge, by email: $520.00" });
    await call("email_hotel");
    expect((await session.memory()).facts.at(-1)).toEqual({
      kind: "refund_decision",
      text: "Nora needs a real night's sleep",
      hotel: "Bow River Lodge",
      amountCents: 52000,
      route: "email",
      childName: "Nora",
    });
  });

  it("with the learner on, one yes covers the rebook and the refund request, and nothing happens without it (Scenario 3)", async () => {
    const { call, session, storm } = setup();
    const rules = approvalRules(session) as Record<string, (i: unknown) => Promise<unknown>>;
    await session.saveMemory({
      facts: [{ kind: "learned_choice", text: "Nora needs a real night's sleep", chose: "overnight-at-hub", over: "later-connection", childName: "Nora" }],
    });
    await session.update((s) => void (s.learner = true));
    await storm();
    await call("check_disruption");
    await call("find_rebooking_options");
    expect(await rules.request_approval({ optionId: "overnight-at-hub" })).toEqual({
      type: "user-approval",
      reason:
        "Overnight at ORD, first flight out tomorrow: $401.79 | Also request $520.00 back from Bow River Lodge for the missed night, by email, if the hotel approves",
    });
    expect(Object.keys(await import("./tools").then((m) => m.makeTools(session)))).not.toContain("act_under_mandate");
    const approved = await call("request_approval", { optionId: "overnight-at-hub" });
    expect((await session.state()).approvals[approved.approvalId as string]).toMatchObject({ includesRefund: true });
    await call("execute_rebook", { approvalId: approved.approvalId });
    await call("check_hotel_policy");
    expect(await rules.email_hotel({})).toEqual({ type: "approved", reason: "covered by the traveler's approval of the rebook" });
  });

  it("reads the hotel's policy only after an overnight rebook, and routes clear to email, unclear to a call (R1)", async () => {
    const { call, session, storm } = setup();
    await storm();
    await call("check_disruption");
    await call("find_rebooking_options");
    expect(await call("check_hotel_policy")).toMatchObject({ refused: true });
    const { approvalId } = await call("request_approval", { optionId: "overnight-at-hub" });
    await call("execute_rebook", { approvalId });
    expect(await call("call_hotel")).toMatchObject({ refused: true, reason: expect.stringMatching(/check the policy first/) });

    const policy = await call("check_hotel_policy");
    expect(policy).toMatchObject({ hotel: "Bow River Lodge", clarity: "clear", next: "email_hotel", source: "demo content (fictional hotel)" });
    expect(policy.request).toBe(
      "$520.00 requested for the missed night at Bow River Lodge, which would more than cover tonight's $401.79 room if the hotel approves.",
    );
    expect(await call("call_hotel")).toMatchObject({ refused: true });
    const emailed = await call("email_hotel");
    expect(emailed).toMatchObject({ requested: true, sent: false });
    expect(await call("email_hotel")).toMatchObject({ refused: true, reason: "a refund has already been requested" });
    expect((await session.state()).refund).toMatchObject({ route: "email", amountCents: 52000 });

    // Trip 2: the recorded terms are unclear, so it calls; without live calls the call is simulated and labelled
    await session.nextTrip();
    await storm();
    await call("check_disruption");
    await call("find_rebooking_options");
    const second = await call("request_approval", { optionId: "overnight-at-hub" });
    await call("execute_rebook", { approvalId: second.approvalId });
    expect(await call("check_hotel_policy")).toMatchObject({ hotel: "Delta Calgary Airport", clarity: "unclear", next: "call_hotel", policy: "Non-refundable · up to 01 days after booking" });
    expect(await call("email_hotel")).toMatchObject({ refused: true });
    const called = await call("call_hotel");
    expect(called).toMatchObject({ requested: true, placed: false, simulated: true });
    expect((called.transcript as { text: string }[]).every((l) => l.text.startsWith("[simulated]"))).toBe(true);
    // R1: requested, never received
    for (const text of [policy.request, called.request, JSON.stringify(called.transcript)]) {
      expect(String(text)).not.toMatch(/\b(refunded|saved you|guaranteed)\b/i);
    }
  });

  it("the trip summary lists every action actually taken, and nothing else (R3)", async () => {
    const { call, storm } = setup();
    await storm();
    await call("check_disruption");
    await call("find_rebooking_options");
    expect(await call("send_trip_summary")).toMatchObject({ refused: true });
    const { approvalId } = await call("request_approval", { optionId: "later-connection" });
    await call("execute_rebook", { approvalId });
    await call("settle_payment", { approvalId });
    // No overnight, so no night is missed and no refund is asked for
    expect(await call("check_hotel_policy")).toMatchObject({ refused: true });
    const summary = await call("send_trip_summary");
    expect(summary.actions).toEqual([expect.stringMatching(/^Rebooked onto UA 1156 ORD→YYC .* with your approval; booking QKRVTA$/)]);
    expect(await call("send_trip_summary")).toMatchObject({ refused: true });
  });

  it("takes no recipient from the model", () => {
    const { tools } = setup();
    expect(Object.keys((tools.notify_traveler.inputSchema as unknown as { shape: object }).shape)).toEqual(["channel"]);
    for (const name of ["email_hotel", "call_hotel", "send_trip_summary", "check_hotel_policy"] as const) {
      expect(Object.keys((tools[name].inputSchema as unknown as { shape: object }).shape), name).toEqual([]);
    }
  });

  it("takes no amount or approval flag from the model", () => {
    const { tools } = setup();
    const keys = (name: "execute_rebook" | "settle_payment") =>
      Object.keys((tools[name].inputSchema as unknown as { shape: object }).shape);
    expect(keys("execute_rebook")).toEqual(["approvalId"]);
    expect(keys("settle_payment")).toEqual(["approvalId"]);
  });
});

describe("session state", () => {
  it("reset trip keeps memory; reset all clears it (S9a, S9b)", async () => {
    const { call, session, storm } = setup();
    await storm();
    await call("check_disruption");
    await call("remember_traveler", { kind: "travels_with_infant", text: "we have a baby" });

    await session.resetTrip();
    expect((await session.state()).repairCase).toBeUndefined();
    expect((await session.memory()).facts).toHaveLength(1);

    await session.resetAll();
    expect((await session.memory()).facts).toHaveLength(0);
  });

  it("refuses to run on Vercel without Redis", () => {
    expect(() => getStore({ VERCEL_ENV: "preview" })).toThrow(StateConfigError);
    expect(() => getStore({ VERCEL_ENV: "production" })).toThrow(StateConfigError);
    expect(getStore({})).toBeInstanceOf(MemoryStore);
  });

  it("accepts the Marketplace's KV_* names as well as UPSTASH_*", () => {
    expect(redisConfig({ KV_REST_API_URL: "https://kv", KV_REST_API_TOKEN: "t" })).toEqual({ url: "https://kv", token: "t" });
    expect(redisConfig({ UPSTASH_REDIS_REST_URL: "https://u", UPSTASH_REDIS_REST_TOKEN: "t" })).toEqual({ url: "https://u", token: "t" });
    expect(redisConfig({ KV_REST_API_URL: "https://kv" })).toBeUndefined();
    expect(() => getStore({ VERCEL_ENV: "production", KV_REST_API_URL: "https://kv", KV_REST_API_TOKEN: "t" })).not.toThrow();
  });
});
