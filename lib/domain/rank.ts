import { buildGraph, resolveInfant } from "@/lib/graph/build";
import type { Fact, Walk } from "@/lib/graph/types";
import { supportsFamilyFirst, walk } from "@/lib/graph/walk";
import type { ProfileStore } from "@/lib/profiles";
import { addDays } from "@/lib/replay/shift";

import { hotelRates, searchHotels, type SupplierCall } from "./supplier";
import type { ContextMode, HotelQuote, Reason, RepairCase, RepairOption, Trip, TravelerMemory } from "./types";

// Ranking. The agent walks the traveler context graph from the storm to the
// people it affects. When the walk reaches an infant on the booking and a
// preference learned from what the traveler chose for her last time, family
// fit leads; otherwise, or in
// "booking only" mode, the traveler gets moving soonest. Both rankings price
// the overnight's room, because what an option costs is a fact about the
// option, not about what the agent knows. Context changes the order and the
// reasons, never a price or a permission.

export type Signals = {
  /** A child is on the booking. */
  hasChild: boolean;
  childName: string;
  childAge: number;
  adults: number;
  children: number;
  /** A preference learned from a choice the traveler made. */
  remembered: boolean;
  /** Why they chose it, in their words. */
  learnedWhy?: string;
};

export function learnerSignals(trip: Trip, memory?: TravelerMemory): Signals {
  const children = trip.travelers.filter((t) => t.type === "infant");
  const fact = memory?.facts.findLast((f) => f.kind === "learned_choice" && f.chose === "overnight-at-hub");
  const named = fact?.kind === "learned_choice" ? resolveInfant(trip, fact.childName) : undefined;
  return {
    learnedWhy: fact?.text,
    hasChild: children.length > 0,
    childName: named?.name || children[0]?.name || "",
    childAge: children[0]?.age ?? 1,
    adults: trip.travelers.length - children.length,
    children: children.length,
    remembered: Boolean(fact),
  };
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Sheraton Chicago Ohare Airport" -> "Sheraton O'Hare". */
export function shortHotel(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (!words.length) return "the hotel";
  if (words.slice(1).some((w) => w.toLowerCase().includes("hare"))) return `${words[0]} O'Hare`;
  return words.slice(0, 2).join(" ");
}

/** Shop a crib-capable room at the hub for the stopover night and put its price on the option. */
function priceOvernight(
  option: RepairOption,
  signals: Signals,
  night: string,
  depart: string | undefined,
  calls: SupplierCall[],
): RepairOption {
  const hub = option.overnightAt!;
  const found = searchHotels(hub, night, depart);
  calls.push(found.call);
  const property = found.hotels.find((h) => h.crib) ?? found.hotels[0];
  if (!property) {
    return { ...option, hotelError: `no room could be quoted at ${hub}` };
  }
  const party = { adults: Math.max(signals.adults, 1), children: Math.max(signals.children, 1), childAge: signals.childAge };
  const priced = hotelRates(property.hotelCode, night, party, depart);
  calls.push(priced.call);
  if (!priced.rate || priced.rate.total <= 0) {
    return { ...option, hotelError: `no rate came back for ${property.name}` };
  }

  const hotel: HotelQuote = { ...property, ...priced.rate, airport: hub, checkin: night, checkout: addDays(night, 1) };
  // The crib is the learner's line to deliver; the baseline names the room and its price.
  const cribNote = !option.familyAware
    ? ""
    : hotel.crib && hotel.cribCharge === 0
      ? "crib at no charge"
      : hotel.crib && hotel.cribCharge
        ? `crib ${money(hotel.cribCharge)}`
        : hotel.crib
          ? "crib available"
          : "";

  // A real rate is the only thing that clears `roomUnpriced`.
  const rest = { ...option };
  delete rest.roomUnpriced;
  return {
    ...rest,
    hotel,
    priceDelta: Math.round(hotel.total * 100) / 100,
    priceNote: `the flights are covered; ${money(hotel.total)} is the room`,
    rationale: [...option.rationale, `${hotel.name}, one night by the airport${cribNote ? `: ${cribNote}` : ""}`],
    accommodations: cribNote ? [...option.accommodations, cribNote] : option.accommodations,
  };
}

function enrich(option: RepairOption, signals: Signals): RepairOption {
  const who = signals.childName || "the infant in the party";
  return {
    ...option,
    rationale: [...option.rationale, `requests a bassinet row for ${who} on the new flight`],
    accommodations: [...option.accommodations, "bassinet row"],
    familyAware: true,
    familyFit: 0.95,
  };
}

/** The reasons for the promoted option, each with the graph path behind it. */
function reasoning(option: RepairOption, signals: Signals, repairCase: RepairCase, w: Walk) {
  const who = signals.childName || "the baby";
  const find = (kind: Fact["kind"], label?: string) =>
    w.applicable.find((f) => f.kind === kind && (!label || f.label === label))?.path;
  const infant = find("traveler");
  const crib = find("requirement", "Crib if overnight");
  const because: Reason[] = [
    { text: `${who} is a lap infant on this booking`, path: infant },
    {
      text: `${repairCase.connectionLeftMinutes} minutes to change planes, with a stroller`,
      path: infant?.slice(0, 2),
    },
    { text: `last time you chose the overnight: “${signals.learnedWhy ?? "for the baby"}”`, path: find("learned") },
  ];
  const decided = find("decision");
  if (decided) because.push({ text: "and you asked the hotel for the missed night back, so I will again", path: decided });
  if (option.hotel) {
    because.push({ text: `${shortHotel(option.hotel.name)} has a room tonight`, path: crib && [...crib, option.hotel.name] });
    if (option.hotel.crib) because.push({ text: "the nearest one that can take a crib", path: crib });
  }
  return { headline: `Last time you chose a night's stop for ${who}`, because, tradeoff: option.tradeoff };
}

const baselineKey = (o: RepairOption) => [o.arrivalDeltaMinutes, o.priceDelta];
const learnerKey = (o: RepairOption) => [-o.familyFit, o.priceDelta, o.arrivalDeltaMinutes];

const byKey = (key: (o: RepairOption) => number[]) => (a: RepairOption, b: RepairOption) => {
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
};

/**
 * Rank the options. The learner applies only when a preference learned from
 * the traveler's own choice ties to an infant actually on the booking: a
 * learned fact with no child to seat is not a reason to re-rank.
 */
export function rank(
  options: RepairOption[],
  ctx: {
    trip: Trip;
    repairCase: RepairCase;
    memory?: TravelerMemory;
    depart?: string;
    mode?: ContextMode;
    profiles?: ProfileStore;
    /** The learner switch; off unless set. */
    learner?: boolean;
  },
): { ranked: RepairOption[]; learnerApplied: boolean; calls: SupplierCall[]; walk: Walk } {
  const signals = learnerSignals(ctx.trip, ctx.memory);
  const graph = buildGraph({ trip: ctx.trip, repairCase: ctx.repairCase, memory: ctx.memory, profiles: ctx.profiles });
  // Every replacement leg is a single non-stop flight (options.ts), so a direct-flights preference is met by all of them.
  const w = walk(graph, { everyOptionNonStop: options.length > 0, learner: ctx.learner });
  const applied = ctx.mode !== "booking" && supportsFamilyFirst(w);
  // With context on, the infant on the booking shows on the options that can serve her (bassinet, crib),
  // whether or not anything has been learned. Only a learned choice reorders.
  const infantSeen =
    ctx.mode !== "booking" && w.coverage.status === "complete" && w.applicable.some((f) => f.kind === "traveler");
  const night = ctx.repairCase.onward.departDate;
  const calls: SupplierCall[] = [];

  let working = options.map((o) => {
    const base = infantSeen && o.familyCapable ? enrich(o, signals) : { ...o };
    return o.id === "overnight-at-hub" ? priceOvernight(base, signals, night, ctx.depart, calls) : base;
  });

  working = [...working].sort(byKey(applied ? learnerKey : baselineKey));
  if (applied && working[0]?.familyAware) {
    working[0] = { ...working[0], reasoning: reasoning(working[0], signals, ctx.repairCase, w) };
  }
  return { ranked: working.map((o, i) => ({ ...o, rank: i })), learnerApplied: applied, calls, walk: w };
}
