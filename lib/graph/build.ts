import { itemId } from "@/lib/domain/detect";
import type { RepairCase, Segment, Traveler, TravelerMemory, Trip } from "@/lib/domain/types";
import { profileStore, type ProfileStore } from "@/lib/profiles";
import { daysBetween } from "@/lib/replay/shift";

import type { ContextGraph, GraphEdge, GraphNode, Source } from "./types";

// Builds the graph from what the session knows: the booked trip (the standing
// hierarchy), the open repair case (the one-shot event and its keys), what the
// traveler has said, and each traveler's profile, fetched by traveler id from
// the separate profile store. Same inputs, same graph.

const segmentLabel = (s: Segment) => `${s.carrier} ${s.number} ${s.from}→${s.to}`;

export const nodeIds = {
  event: (c: RepairCase) => `event:${c.id}`,
  trip: (t: Trip) => `trip:${t.id}`,
  booking: (locator: string) => `booking:${locator}`,
  segment: (item: string) => `segment:${item}`,
  party: (t: Trip) => `party:${t.id}`,
  traveler: (p: Traveler) => `traveler:${p.id}`,
  requirement: (p: Traveler, what: string) => `requirement:${p.id}:${what}`,
  statement: (i: number) => `statement:${i}`,
  learned: (i: number) => `learned:${i}`,
  decision: (i: number) => `decision:${i}`,
  preference: (p: Traveler, i: number) => `preference:${p.id}:${i}`,
  entitlement: (p: Traveler, i: number) => `entitlement:${p.id}:${i}`,
};

/** Who a statement about travelling with an infant is about, if that can be told. */
export function resolveInfant(trip: Trip, childName?: string): Traveler | undefined {
  const infants = trip.travelers.filter((t) => t.type === "infant");
  if (childName) return infants.find((t) => t.name.toLowerCase() === childName.trim().toLowerCase());
  return infants.length === 1 ? infants[0] : undefined;
}

export function buildGraph(input: {
  trip: Trip;
  repairCase?: RepairCase;
  memory?: TravelerMemory;
  profiles?: ProfileStore;
}): ContextGraph {
  const { trip, repairCase, memory, profiles = profileStore } = input;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const issues: string[] = [];
  const onBooking: Source = { kind: "booking", ref: trip.bookingCode };
  const add = (n: GraphNode) => nodes.push(n);
  const link = (from: string, to: string, rel: GraphEdge["rel"], source: Source) => edges.push({ from, to, rel, source });

  // ── the standing operational hierarchy: Trip owns Booking owns Segments ────
  const tripId = nodeIds.trip(trip);
  const bookingId = nodeIds.booking(trip.bookingCode);
  add({
    id: tripId,
    kind: "trip",
    label: `${trip.hotel.city} trip`,
    detail: `${daysBetween(trip.hotel.checkin, trip.hotel.checkout)} nights`,
    source: onBooking,
    keys: { trip_id: trip.id },
  });
  add({
    id: bookingId,
    kind: "booking",
    label: `Booking ${trip.bookingCode}`,
    detail: "BOOKED",
    source: onBooking,
    keys: { booking_locator: trip.bookingCode },
  });
  link(tripId, bookingId, "OWNS", onBooking);

  const affectedItem = repairCase && (repairCase.affectedItemId ?? itemId(repairCase.onward));
  for (const s of trip.segments) {
    const item = itemId(s);
    const id = nodeIds.segment(item);
    add({
      id,
      kind: "segment",
      label: segmentLabel(s),
      detail: `${s.departDate.slice(5)} ${s.departTime}`,
      source: onBooking,
      keys: { item_id: item, booking_locator: trip.bookingCode },
      affected: item === affectedItem,
    });
    link(bookingId, id, "CONTAINS_SEGMENT", onBooking);
  }

  // ── who is flying: Trip owns Party; Party has members ─────────────────────
  const partyId = nodeIds.party(trip);
  const infants = trip.travelers.filter((t) => t.type === "infant").length;
  const adults = trip.travelers.length - infants;
  add({
    id: partyId,
    kind: "party",
    label: `Party of ${trip.travelers.length}`,
    detail: `${adults} adults${infants ? ` · ${infants} infant` : ""}`,
    source: onBooking,
  });
  link(tripId, partyId, "OWNS", onBooking);

  for (const p of trip.travelers) {
    const id = nodeIds.traveler(p);
    add({
      id,
      kind: "traveler",
      label: p.type === "infant" ? `${p.name} (infant)` : p.name,
      detail: p.type === "infant" ? "lap infant" : "adult",
      source: onBooking,
      keys: { traveler_id: p.id },
    });
    link(partyId, id, "MEMBER", onBooking);

    // Derived by rule over Party.members, never stored.
    if (p.type === "infant") {
      const rule: Source = { kind: "derived", ref: "Party.members where role == infant" };
      for (const [what, label] of [
        ["bassinet", "Bassinet row"],
        ["crib", "Crib if overnight"],
      ] as const) {
        const rid = nodeIds.requirement(p, what);
        add({ id: rid, kind: "requirement", label, source: rule });
        link(id, rid, "REQUIRES", rule);
      }
    }

    // Fetched from the separate profile system by traveler id.
    let profile;
    try {
      profile = profiles(p.id);
    } catch (err) {
      issues.push(`profile for ${p.name} could not be fetched (${String(err)})`);
      continue;
    }
    const fetched: Source = { kind: "profile", ref: `traveler_id ${p.id}` };
    profile?.preferences.forEach((pref, i) => {
      const pid = nodeIds.preference(p, i);
      add({ id: pid, kind: "preference", label: pref.label, detail: `${pref.kind}: ${pref.value}`, source: fetched });
      link(id, pid, "HAS_PREFERENCE", fetched);
    });
    profile?.entitlements.forEach((ent, i) => {
      const eid = nodeIds.entitlement(p, i);
      add({
        id: eid,
        kind: "entitlement",
        label: `${ent.tier} member`,
        detail: `${ent.program}${ent.redemption === "points_first" ? " · points first" : ""}`,
        source: fetched,
      });
      link(id, eid, "HAS_ENTITLEMENT", fetched);
    });
  }

  // ── the one-shot event, attaching by reference keys ────────────────────────
  if (repairCase) {
    const locator = repairCase.bookingLocator ?? trip.bookingCode;
    const event = nodeIds.event(repairCase);
    const fired: Source = { kind: "event", ref: `weather ${repairCase.hub}` };
    add({
      id: event,
      kind: "event",
      label: `Storm at ${repairCase.hub}`,
      detail: `${repairCase.connectionLeftMinutes} of ${repairCase.bookedConnectionMinutes} min left`,
      source: fired,
      keys: { booking_locator: locator, affected_item_id: affectedItem! },
    });
    // The edge exists only if the keys resolve into the standing hierarchy.
    const target = nodes.find((n) => n.kind === "segment" && n.keys?.item_id === affectedItem && n.keys?.booking_locator === locator);
    if (target) link(event, target.id, "AFFECTS", { kind: "derived", ref: "reference keys: locator + item" });
  }

  // ── what the traveler told the agent, and what it learned from their choices ─
  let lastLearned: string | undefined;
  memory?.facts.forEach((f, i) => {
    if (f.kind === "refund_decision") {
      const id = nodeIds.decision(i);
      const decided: Source = { kind: "conversation", ref: `refund requested from ${f.hotel}: ${f.text}` };
      const amount = `$${(f.amountCents / 100).toFixed(2)}`;
      add({ id, kind: "decision", label: `Asked ${f.hotel} for ${amount} back`, detail: `because “${f.text}”`, source: decided });
      const who = resolveInfant(trip, f.childName);
      link(id, who ? nodeIds.traveler(who) : tripId, "SAID_ABOUT", decided);
      // The justification it carries is the choice it followed from.
      if (lastLearned) link(id, lastLearned, "BECAUSE", decided);
      return;
    }
    if (f.kind === "learned_choice") {
      lastLearned = nodeIds.learned(i);
      const id = nodeIds.learned(i);
      const learned: Source = { kind: "conversation", ref: `chose ${f.chose} over ${f.over}: ${f.text}` };
      const overnight = f.chose === "overnight-at-hub";
      const chose = overnight ? "the overnight" : "the later connection";
      add({ id, kind: "learned", label: `Chose ${chose}: “${f.text}”`, detail: "learned from a choice", source: learned });
      // A choice of the family option is about the infant it served (left untied, and so
      // degrading coverage, when that child can't be found); any other choice is about the trip.
      if (!overnight) link(id, tripId, "SAID_ABOUT", learned);
      else {
        const who = resolveInfant(trip, f.childName);
        if (who) link(id, nodeIds.traveler(who), "SAID_ABOUT", learned);
      }
      return;
    }
    const id = nodeIds.statement(i);
    const said: Source = { kind: "conversation", ref: f.text };
    add({ id, kind: "statement", label: `“${f.text}”`, detail: f.kind === "travels_with_infant" ? "travelling with an infant" : "note", source: said });
    if (f.kind === "travels_with_infant") {
      const who = resolveInfant(trip, f.childName);
      if (who) link(id, nodeIds.traveler(who), "SAID_ABOUT", said);
    } else {
      link(id, tripId, "SAID_ABOUT", said);
    }
  });

  return { nodes, edges, issues };
}
