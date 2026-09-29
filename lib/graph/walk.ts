import type { ContextGraph, Fact, GraphNode, UnusedFact, Walk } from "./types";

// Walks from the event to the people it affects and sorts what it finds into
// facts that bear on the repair and facts that do not. Deterministic: the
// rules below are the whole of it. The walk never grants anything; it only
// decides what the ranking may take into account.
//
// The order mirrors "listen once, fetch on demand": the event's reference
// keys resolve to a booked segment, the segment leads up to its booking and
// trip, the trip down to its party and members, and each member out to what
// was fetched for them.

export const ENTITLEMENT_UNUSED = "not used: the hotel rates we have are cash-only, so points can't be priced";
export const LEARNER_OFF = "written down, but the learner is off: not used yet";

export type WalkFacts = {
  /** Every repair option already satisfies a direct-flights preference (all replacements are non-stop). */
  everyOptionNonStop?: boolean;
  /** The learner switch: whether what was learned from the traveler's choices may be used. Off unless set. */
  learner?: boolean;
};

export function walk(graph: ContextGraph, facts: WalkFacts = {}): Walk {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = (id: string, rel: string) => graph.edges.filter((e) => e.from === id && e.rel === rel).map((e) => byId.get(e.to)!);
  const into = (id: string, rel: string) => graph.edges.filter((e) => e.to === id && e.rel === rel).map((e) => byId.get(e.from)!);

  const event = graph.nodes.find((n) => n.kind === "event");
  const none: Walk = { reached: [], applicable: [], unused: [], coverage: { status: "degraded", reason: "no disruption to walk from" } };
  if (!event) return none;

  const reached: string[] = [event.id];
  const fact = (n: GraphNode, path: GraphNode[]): Fact => ({
    nodeId: n.id,
    kind: n.kind,
    label: n.label,
    path: [...path, n].map((p) => p.label),
  });
  const degraded = (reason: string): Walk => ({ reached, applicable: [], unused: [], coverage: { status: "degraded", reason } });

  // event -(keys)-> segment -> booking -> trip
  const segment = out(event.id, "AFFECTS")[0];
  if (!segment) {
    return degraded(`the event's keys (${event.keys?.booking_locator} / ${event.keys?.affected_item_id}) match no booked segment`);
  }
  const booking = into(segment.id, "CONTAINS_SEGMENT")[0];
  const trip = booking && into(booking.id, "OWNS")[0];
  if (!booking || !trip) return degraded("the affected segment is not on a known booking");
  reached.push(segment.id, booking.id, trip.id);

  // trip -> party -> members
  const party = out(trip.id, "OWNS").find((n) => n.kind === "party");
  if (!party) return degraded("the trip has no party to walk to");
  reached.push(party.id);
  const spine = [event, segment, booking, trip, party];

  const applicable: Fact[] = [];
  const unused: UnusedFact[] = [];

  for (const traveler of out(party.id, "MEMBER")) {
    reached.push(traveler.id);
    const toTraveler = [...spine, traveler];
    if (traveler.detail === "lap infant") {
      applicable.push(fact(traveler, spine));
      for (const req of out(traveler.id, "REQUIRES")) {
        reached.push(req.id);
        applicable.push(fact(req, toTraveler));
      }
    }
    for (const pref of out(traveler.id, "HAS_PREFERENCE")) {
      reached.push(pref.id);
      unused.push({
        ...fact(pref, toTraveler),
        reason:
          facts.everyOptionNonStop === undefined
            ? "no options to compare yet"
            : facts.everyOptionNonStop
              ? "met by every option: all are non-stop, so it doesn't change the order"
              : "not used: routing preferences are not ranked in this demo",
      });
    }
    for (const ent of out(traveler.id, "HAS_ENTITLEMENT")) {
      reached.push(ent.id);
      unused.push({ ...fact(ent, toTraveler), reason: ENTITLEMENT_UNUSED });
    }
    // What the traveler said about this member, and what the agent learned from their choices.
    for (const said of into(traveler.id, "SAID_ABOUT")) {
      reached.push(said.id);
      const learned = said.kind === "learned" || said.kind === "decision";
      if (learned && !facts.learner) unused.push({ ...fact(said, toTraveler), reason: LEARNER_OFF });
      else applicable.push(fact(said, toTraveler));
    }
  }

  // What the traveler said about the trip in general does not bear on a flight repair.
  for (const statement of into(trip.id, "SAID_ABOUT")) {
    reached.push(statement.id);
    unused.push({ ...fact(statement, spine.slice(0, 4)), reason: "not about this disruption" });
  }

  // Missing data is reported, never silently defaulted.
  if (graph.issues.length) {
    return { reached, applicable, unused, coverage: { status: "degraded", reason: graph.issues[0] } };
  }
  const tied = new Set(graph.edges.filter((e) => e.rel === "SAID_ABOUT").map((e) => e.from));
  const loose = graph.nodes.find((n) => (n.kind === "statement" || n.kind === "learned" || n.kind === "decision") && !tied.has(n.id));
  if (loose) {
    return { reached, applicable, unused, coverage: { status: "degraded", reason: `couldn't tell who ${loose.label} is about` } };
  }

  return { reached, applicable, unused, coverage: { status: "complete" } };
}

/**
 * The walk supports family-first ranking: an infant on the booking, and a
 * preference learned from what the traveler chose for her before. The infant
 * alone, or being told about her, is not a reason to cost the family a day.
 */
export function supportsFamilyFirst(w: Walk): boolean {
  return (
    w.coverage.status === "complete" &&
    w.applicable.some((f) => f.kind === "traveler") &&
    w.applicable.some((f) => f.kind === "learned")
  );
}
