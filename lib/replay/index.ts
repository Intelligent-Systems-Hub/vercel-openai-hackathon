import { casting, loadPair, type Pair } from "@/lib/fixtures";

import { match, type MatchKind } from "./match";
import { addDays, daysBetween, shiftDates } from "./shift";

export { ReplayMiss } from "./match";

export type Replayed = {
  path: string;
  digest: string;
  kind: MatchKind | "pinned";
  ok: boolean;
  status: number;
  /** The recorded body, parsed, with travel dates moved onto the demo calendar. */
  body: unknown;
};

/** The day the booked trip departs in the demo: DEMO_DEPART, else tomorrow (UTC). */
export function demoDepart(): string {
  return process.env.DEMO_DEPART ?? addDays(new Date().toISOString().slice(0, 10), 1);
}

/** Whole days between the recordings' calendar and the demo's. */
export function dayOffset(depart = demoDepart()): number {
  return daysBetween(casting.captureDepart, depart);
}

function present(pair: Pair, kind: Replayed["kind"], offset: number): Replayed {
  let body: unknown = pair.response.body;
  try {
    body = JSON.parse(pair.response.body);
  } catch {
    // a non-JSON body is served as recorded
  }
  return {
    path: pair.meta.fullPath,
    digest: pair.meta.requestDigest,
    kind,
    ok: pair.meta.ok,
    status: pair.response.status,
    body: shiftDates(body, offset),
  };
}

/** Answer a supplier call from the recordings. Throws ReplayMiss when none fits. */
export function replay(path: string, request: unknown, depart = demoDepart()): Replayed {
  const offset = dayOffset(depart);
  const { pair, kind } = match(path, shiftDates(request, -offset));
  return present(pair, kind, offset);
}

/** Serve one named recording regardless of the request: the cast rebook steps. */
export function replayPinned(ref: { path: string; digest: string }, depart = demoDepart()): Replayed {
  return present(loadPair(ref.path, ref.digest), "pinned", dayOffset(depart));
}
