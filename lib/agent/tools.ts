import { tool, type ToolApprovalConfiguration } from "ai";
import { z } from "zod";

import { itineraryText } from "@/lib/actions/calendar";
import { callConfigured, callInstructions, liveCalls, placeCall, simulatedCall } from "@/lib/actions/call";
import { emailTo, mask, NotAllowedError, notify, recipient } from "@/lib/actions/notify";
import { actionsTaken, tripSummaryText } from "@/lib/actions/summary";
import { consumeApproval, createApproval, findOption, formatCents } from "@/lib/approvals";
import { detect } from "@/lib/domain/detect";
import { execute } from "@/lib/domain/execute";
import { hotelPolicy, refundAsk, refundEmail } from "@/lib/domain/policy";
import { priceCents } from "@/lib/domain/gate";
import { buildOptions } from "@/lib/domain/options";
import { rank } from "@/lib/domain/rank";
import { settle } from "@/lib/domain/settle";
import { searchHotels, weatherAlert } from "@/lib/domain/supplier";
import type { RepairOption, Segment, Trip, TravelerMemory } from "@/lib/domain/types";
import type { Walk } from "@/lib/graph/types";
import type { Session, TripState } from "@/lib/state";

import { REFUND_PREFIX } from "./approval-text";
import { offered } from "./offered";

// The agent's tools. Every decision that matters is made here, in code: which
// options exist, their order, their prices, and whether a booking or a charge
// may happen. The model chooses which tool to call and explains the results.

const flight = (s: Segment) =>
  `${s.carrier} ${s.number} ${s.from}→${s.to} ${s.departDate} ${s.departTime}–${s.arriveTime}`;

function tripSummary(trip: Trip) {
  return {
    bookingCode: trip.bookingCode,
    travelers: trip.travelers.map((t) => `${t.name} (${t.type})`),
    flights: trip.segments.map(flight),
    hotel: `${trip.hotel.name}, ${trip.hotel.checkin} to ${trip.hotel.checkout}`,
  };
}

function optionSummary(o: RepairOption) {
  return {
    id: o.id,
    rank: o.rank,
    title: o.title,
    newFlight: o.changed.map((c) => flight(c.now)),
    replaces: o.changed.map((c) => flight(c.was)),
    arrivesLaterByMinutes: o.arrivalDeltaMinutes,
    price: o.roomUnpriced ? "room not yet priced" : formatCents(priceCents(o) ?? 0),
    priceNote: o.priceNote,
    hotel: o.hotel ? `${o.hotel.name} (${o.hotel.crib ? "crib available" : "no crib listed"})` : undefined,
    rationale: o.rationale,
    tradeoff: o.tradeoff || undefined,
    reasoning: o.reasoning,
  };
}

/**
 * The day the booked trip departs. Replay aligns the recordings to it, so it
 * comes from the trip itself, not the clock: a session started yesterday
 * still shops its own dates today.
 */
export const tripDepart = (state: TripState) => state.trip.segments[0].departDate;

/**
 * Shop and rank the open case in place, in the session's context mode.
 * Shared by find_rebooking_options and the director's context toggle.
 */
export function rerank(state: TripState, memory: TravelerMemory, depart = tripDepart(state)) {
  const built = buildOptions(state.trip, state.repairCase!, depart);
  const ranked = rank(built.options, {
    trip: state.trip,
    repairCase: state.repairCase!,
    memory,
    depart,
    mode: state.contextMode ?? "context",
    learner: state.learner,
  });
  state.options = ranked.ranked;
  state.learnerApplied = ranked.learnerApplied;
  return { ...ranked, calls: [...built.calls, ...ranked.calls] };
}

/** What the walk found, for the model: facts it may cite, with their paths, and facts it must not use. */
function contextSummary(mode: string, w: Walk, applied: boolean) {
  return {
    mode,
    coverage: w.coverage.status === "complete" ? "complete" : `degraded: ${w.coverage.reason}`,
    used: applied ? w.applicable.map((f) => ({ fact: f.label, path: f.path.join(" → ") })) : [],
    notUsed: [
      ...w.unused.map((f) => ({ fact: f.label, why: f.reason })),
      ...(applied || mode === "booking" ? [] : w.applicable.map((f) => ({ fact: f.label, why: "known, but not enough to change the ranking" }))),
      ...(mode === "booking" ? [{ fact: "traveler context", why: "booking-only mode" }] : []),
    ],
  };
}

/** The delay as the hotel hears it: what broke, what replaces it, when they now arrive. */
function delayFacts(state: TripState) {
  const option = state.options?.find((o) => o.id === state.rebook?.optionId);
  const change = option?.changed[0];
  return {
    hub: state.repairCase?.hub ?? "the connection",
    was: change ? flight(change.was) : "their connection",
    now: change ? flight(change.now) : "a later flight",
    arrives: change?.now.arriveDate ?? "the next day",
  };
}

const guestNames = (state: TripState) => state.trip.travelers.map((t) => t.name).join(", ");

/**
 * When the ranking already knows what this traveler chooses (the learner used
 * a past choice) and the option is the overnight, the one yes also covers
 * asking the destination hotel for the missed night back: nothing left to ask.
 */
function refundBundle(state: TripState, option: RepairOption): string | undefined {
  if (option.id !== "overnight-at-hub" || !state.learnerApplied) return undefined;
  const policy = hotelPolicy(state.trip);
  if (!policy) return undefined;
  const ask = refundAsk(state.trip, option.hotel);
  const how = policy.clarity === "clear" ? "by email" : "by phone";
  return `Also request ${formatCents(ask.amountCents)} back from ${ask.hotel} for the missed night, ${how}, if the hotel approves`;
}

/** Record the traveler's yes to the refund request on the graph, with the reason it followed from. */
async function recordRefundDecision(session: Session, state: TripState, route: "email" | "call") {
  const ask = state.policy!.ask;
  const memory = await session.memory();
  const why = memory.facts.findLast((f) => f.kind === "learned_choice")?.text ?? "the flight disruption";
  const infant = state.trip.travelers.find((t) => t.type === "infant");
  memory.facts.push({ kind: "refund_decision", text: why, hotel: ask.hotel, amountCents: ask.amountCents, route, childName: infant?.name });
  await session.saveMemory(memory);
}

export function makeTools(session: Session) {
  return {
    get_trip: tool({
      description: "The traveler's booked trip: party, flights and hotel.",
      inputSchema: z.object({}),
      execute: async () => tripSummary((await session.state()).trip),
    }),

    check_disruption: tool({
      description:
        "Check the weather at the trip's connecting airport and whether it breaks the connection. Opens a repair case when it does.",
      inputSchema: z.object({}),
      execute: () =>
        session.update((state) => {
          const hub = state.trip.segments[0].to;
          const alert = state.storm ? weatherAlert(hub) : undefined;
          const result = detect(state.trip, alert, state.repairCase);
          if (result.opened) state.repairCase = result.repairCase;
          const c = result.repairCase;
          return {
            disrupted: Boolean(c),
            reason: result.opened ? undefined : result.reason,
            case: c && {
              hub: c.hub,
              weather: c.alert.summary,
              delayMinutes: c.delayMinutes,
              bookedConnectionMinutes: c.bookedConnectionMinutes,
              connectionLeftMinutes: c.connectionLeftMinutes,
              minimumConnectMinutes: c.minimumConnectMinutes,
              brokenFlight: flight(c.onward),
            },
          };
        }),
    }),

    find_rebooking_options: tool({
      description:
        "Shop the ways out of the broken connection and rank them by walking the traveler context graph from the disruption to the people it affects. Returns the options and which facts were used (with their graph paths) and which were not. Call after check_disruption, and again after remembering something new.",
      inputSchema: z.object({}),
      execute: async () => {
        const memory = await session.memory();
        return session.update((state) => {
          if (!state.repairCase) return { error: "no open repair case: call check_disruption first" };
          const ranked = rerank(state, memory);
          return {
            usedWhatYouKnow: ranked.learnerApplied,
            learner: state.learner ? "on" : "off",
            context: contextSummary(state.contextMode ?? "context", ranked.walk, ranked.learnerApplied),
            options: offered(ranked.ranked, state.contextMode).map(optionSummary),
            supplierCalls: ranked.calls.map((c) => ({ path: c.path, match: c.kind })),
          };
        });
      },
    }),

    search_hotels: tool({
      description: "Hotels near an airport for one night, and whether each can take a crib.",
      inputSchema: z.object({ airport: z.string().length(3), night: z.string().describe("YYYY-MM-DD") }),
      execute: async ({ airport, night }) => {
        try {
          return { hotels: searchHotels(airport, night, tripDepart(await session.state())).hotels };
        } catch (err) {
          return { error: String(err) };
        }
      },
    }),

    recall_traveler: tool({
      description: "What the traveler has told you before, kept across trips.",
      inputSchema: z.object({}),
      execute: async () => session.memory(),
    }),

    remember_traveler: tool({
      description:
        "Save something the traveler told you so future repairs use it. Use kind travels_with_infant when they say they are flying with a baby or infant.",
      inputSchema: z.object({
        kind: z.enum(["travels_with_infant", "note"]),
        text: z.string().min(1).describe("What they said, in their words"),
        childName: z.string().optional(),
      }),
      execute: async ({ kind, text, childName }) => {
        const memory = await session.memory();
        if (!memory.facts.some((f) => f.kind === kind && f.text === text)) {
          memory.facts.push(kind === "travels_with_infant" ? { kind, text, childName } : { kind, text });
          await session.saveMemory(memory);
        }
        return memory;
      },
    }),

    learn_from_choice: tool({
      description:
        "When the traveler picks an option other than your top recommendation, record why, in their words. It becomes a learned preference on the context graph that future repairs rank with. Call before request_approval.",
      inputSchema: z.object({
        optionId: z.enum(["later-connection", "overnight-at-hub"]).describe("The option they chose"),
        reason: z.string().min(1).describe("Why they chose it, in their words"),
      }),
      execute: async ({ optionId, reason }) => {
        const state = await session.state();
        const top = state.options?.[0];
        if (!top) return { learned: false, reason: "no options have been offered yet" };
        if (top.id === optionId) return { learned: false, chose: optionId, reason: "they took the recommendation: nothing new to learn" };
        const infant = state.trip.travelers.find((t) => t.type === "infant");
        const fact = { kind: "learned_choice" as const, text: reason, chose: optionId, over: top.id, childName: infant?.name };
        const memory = await session.memory();
        if (!memory.facts.some((f) => f.kind === "learned_choice" && f.chose === optionId && f.text === reason)) {
          memory.facts.push(fact);
          await session.saveMemory(memory);
        }
        return {
          learned: true,
          chose: optionId,
          over: top.id,
          reason,
          graph: `added to the context graph${infant && optionId === "overnight-at-hub" ? `, tied to ${infant.name}` : ""}; used from the next repair on`,
        };
      },
    }),

    present_options: tool({
      description: "Show the ranked options to the traveler as a card. Call after find_rebooking_options.",
      inputSchema: z.object({}),
      execute: async () => {
        const state = await session.state();
        if (!state.options?.length) return { error: "no options yet: call find_rebooking_options first" };
        return { learnerApplied: Boolean(state.learnerApplied), options: offered(state.options, state.contextMode) };
      },
    }),

    request_approval: tool({
      description:
        "Ask the traveler to approve one option at its price. Only call for the option the traveler chose. The traveler sees the price and approves or declines; nothing is booked by this call.",
      inputSchema: z.object({ optionId: z.enum(["later-connection", "overnight-at-hub"]) }),
      // Runs only after the traveler approves in the UI (see approvalRules).
      execute: ({ optionId }) =>
        session.update((state) => {
          const option = findOption(state, optionId);
          if (!option) return { approved: false, error: "that option is not on offer" };
          const bundle = refundBundle(state, option);
          const approval = createApproval(state, option, Boolean(bundle));
          if (!approval) return { approved: false, error: "the option has no price yet, so it cannot be approved" };
          return {
            approved: true,
            approvalId: approval.id,
            optionId,
            amount: formatCents(approval.amountCents),
            alsoApproved: bundle,
            next: "call execute_rebook with this approvalId now, then settle_payment",
          };
        }),
    }),

    execute_rebook: tool({
      description:
        "Rebook onto the approved option. Takes only the approvalId returned by an approved request_approval. The new booking is ticketed before the old one is released.",
      inputSchema: z.object({ approvalId: z.string() }),
      execute: ({ approvalId }) =>
        session.update((state) => {
          if (state.rebook) return { error: "this trip has already been rebooked" };
          const { gate, option } = consumeApproval(state, approvalId);
          if (!gate.allowed) return { refused: true, reason: gate.reason };
          const result = execute();
          state.rebook = { approvalId, optionId: option!.id, result };
          if (result.outcome === "rebooked") {
            state.replaced = state.trip;
            state.trip = { ...state.trip, segments: option!.segments, bookingCode: result.newBookingCode! };
          }
          return {
            outcome: result.outcome,
            oldBooking: result.oldBooking,
            newBookingCode: result.newBookingCode,
            error: result.error,
            steps: result.steps.map((s) => ({ step: s.step, booking: s.bookingCode, ok: s.ok, detail: s.detail })),
          };
        }),
    }),

    settle_payment: tool({
      description:
        "Charge or refund the approved difference after a successful rebook. Takes the same approvalId. Charges at most once.",
      inputSchema: z.object({ approvalId: z.string() }),
      execute: ({ approvalId }) =>
        session.update((state) => {
          if (state.rebook?.approvalId !== approvalId || state.rebook.result.outcome !== "rebooked") {
            return { refused: true, reason: "there is no completed rebook for that approval" };
          }
          const { entry, repeated } = settle(state.approvals[approvalId], state.ledger);
          if (!repeated) state.ledger.push(entry);
          return { ...entry, amount: formatCents(entry.amountCents), alreadySettled: repeated };
        }),
    }),

    notify_traveler: tool({
      description:
        "Send the traveler their new itinerary after a completed rebook. The recipient is on file; you only choose the channel. Sends once per channel.",
      inputSchema: z.object({ channel: z.enum(["email", "sms"]).default("email") }),
      execute: async ({ channel }) => {
        const state = await session.state();
        if (state.rebook?.result.outcome !== "rebooked") {
          return { refused: true, reason: "there is no completed rebook to tell them about" };
        }
        if (state.notified?.includes(channel)) {
          const to = recipient(channel);
          return { channel, to: to ? mask(to) : "", sent: false, reason: "already sent" };
        }
        try {
          const result = await notify(channel, itineraryText(state.trip));
          await session.update((s) => void (s.notified = [...(s.notified ?? []), channel]));
          return result;
        } catch (err) {
          return { refused: true, reason: err instanceof NotAllowedError ? err.message : `could not send: ${String(err)}` };
        }
      },
    }),

    check_hotel_policy: tool({
      description:
        "After rebooking onto an overnight, read the destination hotel's refund policy for the night the family now misses. Says whether it is clear (then email_hotel) or unclear (then call_hotel), and the exact refund to request.",
      inputSchema: z.object({}),
      execute: () =>
        session.update((state) => {
          if (state.rebook?.result.outcome !== "rebooked" || state.rebook.optionId !== "overnight-at-hub") {
            return { refused: true, reason: "no night is missed: the family was not rebooked onto an overnight" };
          }
          const policy = hotelPolicy(state.trip);
          if (!policy) return { refused: true, reason: `no policy is on file for ${state.trip.hotel.name}` };
          const hubRoom = state.options?.find((o) => o.id === "overnight-at-hub")?.hotel;
          const ask = refundAsk(state.trip, hubRoom);
          state.policy = { ...policy, ask };
          return {
            hotel: policy.hotel,
            policy: policy.text,
            source: policy.source,
            clarity: policy.clarity,
            reading: policy.reading,
            next: policy.clarity === "clear" ? "email_hotel" : "call_hotel",
            request: ask.framing,
            // Said plainly, so the model carries on rather than stopping to report.
            then: state.approvals[state.rebook.approvalId]?.includesRefund
              ? `the traveler already approved this request with the rebook: call ${policy.clarity === "clear" ? "email_hotel" : "call_hotel"} now, in this turn`
              : `call ${policy.clarity === "clear" ? "email_hotel" : "call_hotel"} now; the traveler will be asked to confirm`,
          };
        }),
    }),

    email_hotel: tool({
      description:
        "Email the destination hotel to request a refund of the missed night, citing the flight disruption. Only when check_hotel_policy found the policy clear. The address and the words come from the booking; you choose neither. Once per trip.",
      inputSchema: z.object({}),
      execute: async () => {
        const state = await session.state();
        if (state.policy?.clarity !== "clear") return { refused: true, reason: "check the policy first; email only when it is clear" };
        if (state.refund) return { refused: true, reason: "a refund has already been requested" };
        const { ask } = state.policy;
        try {
          const result = await emailTo(process.env.HOTEL_EMAIL, refundEmail(state.trip, ask, delayFacts(state)));
          await session.update((s) => {
            s.refund = { route: "email", hotel: ask.hotel, amountCents: ask.amountCents, framing: ask.framing, to: result.to, sent: result.sent, reason: result.reason };
          });
          await recordRefundDecision(session, state, "email");
          return { requested: true, to: result.to, sent: result.sent, reason: result.reason, request: ask.framing };
        } catch (err) {
          return { refused: true, reason: err instanceof NotAllowedError ? err.message : `could not send: ${String(err)}` };
        }
      },
    }),

    call_hotel: tool({
      description:
        "Phone the destination hotel's customer service on the traveler's behalf to request a refund of the missed night. Only when check_hotel_policy found the policy unclear. The number and what is asked come from the booking. Once per trip.",
      inputSchema: z.object({}),
      execute: async () => {
        const state = await session.state();
        if (state.policy?.clarity !== "unclear") return { refused: true, reason: "check the policy first; call only when it is unclear" };
        if (state.refund) return { refused: true, reason: "a refund has already been requested" };
        const { ask } = state.policy;
        const base = { route: "call" as const, hotel: ask.hotel, amountCents: ask.amountCents, framing: ask.framing };
        await recordRefundDecision(session, state, "call");
        if (liveCalls() && callConfigured()) {
          try {
            const placed = await placeCall(session.id);
            await session.update((s) => {
              s.refund = { ...base, to: placed.to, sent: true, callSid: placed.callSid, transcript: [] };
              s.callBrief = callInstructions(ask, guestNames(s), `A storm at ${delayFacts(s).hub} broke their connection; they now arrive on ${delayFacts(s).arrives}, a night late.`);
            });
            return { requested: true, placed: true, to: placed.to, request: ask.framing, note: "the call is live; its transcript appears as it happens" };
          } catch (err) {
            if (err instanceof NotAllowedError) return { refused: true, reason: err.message };
            // A failed real call falls back to the labelled simulation below.
          }
        }
        const transcript = simulatedCall(ask, guestNames(state));
        await session.update((s) => {
          s.refund = { ...base, to: "the hotel (simulated)", sent: false, simulated: true, transcript, outcome: "sent to the manager for review" };
        });
        return { requested: true, placed: false, simulated: true, transcript, outcome: "sent to the manager for review", request: ask.framing };
      },
    }),

    send_trip_summary: tool({
      description:
        "Email the traveler a summary of the trip as it now stands and every action you took (rebooking, payment, refund request). The content comes from what actually happened; you write none of it. Once per trip.",
      inputSchema: z.object({}),
      execute: async () => {
        const state = await session.state();
        if (state.rebook?.result.outcome !== "rebooked") return { refused: true, reason: "there is nothing to summarise yet" };
        if (state.summary) return { refused: true, reason: "the summary has already been sent" };
        try {
          const result = await notify("email", tripSummaryText(state));
          await session.update((s) => {
            s.summary = { to: result.to, sent: result.sent, reason: result.reason };
          });
          return { to: result.to, sent: result.sent, reason: result.reason, actions: actionsTaken(await session.state()).filter((a) => a.kind !== "summary").map((a) => a.text) };
        } catch (err) {
          return { refused: true, reason: err instanceof NotAllowedError ? err.message : `could not send: ${String(err)}` };
        }
      },
    }),

    add_to_calendar: tool({
      description: "Offer the traveler a calendar file with their rebooked flights.",
      inputSchema: z.object({}),
      execute: async () => {
        const state = await session.state();
        if (state.rebook?.result.outcome !== "rebooked") {
          return { refused: true, reason: "there is no completed rebook to add" };
        }
        return {
          url: `/api/calendar?sessionId=${encodeURIComponent(session.id)}`,
          events: state.trip.segments.map((s) => `${s.carrier} ${s.number} ${s.from}→${s.to} ${s.departDate} ${s.departTime}`),
        };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof makeTools>;

/**
 * Which calls wait for the traveler. Approval is the traveler's alone: the
 * request shows the price the server holds for that option, not one the model
 * wrote.
 */
export function approvalRules(session: Session): ToolApprovalConfiguration<AgentTools, unknown> {
  return {
    request_approval: async ({ optionId }) => {
      const option = findOption(await session.state(), optionId);
      const cents = option && priceCents(option);
      if (!option || cents === undefined) {
        return { type: "denied", reason: "that option cannot be approved yet" };
      }
      const bundle = refundBundle(await session.state(), option);
      return { type: "user-approval", reason: `${option.title}: ${formatCents(cents)}${bundle ? ` | ${bundle}` : ""}` };
    },
    email_hotel: () => refundRule(session, "by email"),
    call_hotel: () => refundRule(session, "by phone"),
  };
}

/**
 * Asking a hotel for money back is the traveler's call too. Asked on its own,
 * unless the yes that approved the rebook already covered it.
 */
async function refundRule(session: Session, how: string): Promise<{ type: "approved" | "user-approval" | "denied"; reason: string }> {
  const state = await session.state();
  const ask = state.policy?.ask;
  if (!ask) return { type: "denied", reason: "check the hotel's policy first" };
  if (state.rebook && state.approvals[state.rebook.approvalId]?.includesRefund) {
    return { type: "approved", reason: "covered by the traveler's approval of the rebook" };
  }
  return { type: "user-approval", reason: `${REFUND_PREFIX}${ask.hotel}, ${how}: ${formatCents(ask.amountCents)}` };
}
