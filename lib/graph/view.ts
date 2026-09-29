import type { ContextMode, TravelerMemory } from "@/lib/domain/types";
import type { TripState } from "@/lib/state";

import { buildGraph } from "./build";
import type { ContextGraph, Walk } from "./types";
import { walk } from "./walk";

export type ContextView = {
  mode: ContextMode;
  graph: ContextGraph;
  walk: Walk;
  /** Node ids that informed the current recommendation. */
  informedBy: string[];
};

/**
 * The graph as the UI and the agent see it: the session's facts, the walk
 * from the storm, and the recommendation with an INFORMED edge from each fact
 * that shaped it. In booking-only mode only the event informs it.
 */
export function contextView(state: TripState, memory: TravelerMemory): ContextView {
  const mode = state.contextMode ?? "context";
  // After a rebook, the graph stays on the trip the storm hit: the one the recommendation was made on.
  const graph = buildGraph({ trip: state.replaced ?? state.trip, repairCase: state.repairCase, memory });
  const w = walk(graph, { everyOptionNonStop: state.options?.length ? true : undefined, learner: state.learner });
  const top = state.options?.[0];
  let informedBy: string[] = [];

  if (top && state.repairCase) {
    const event = graph.nodes.find((n) => n.kind === "event")!;
    informedBy = state.learnerApplied ? [event.id, ...w.applicable.map((f) => f.nodeId)] : [event.id];
    graph.nodes.push({
      id: "recommendation",
      kind: "recommendation",
      label: top.title,
      detail: top.priceDelta > 0 ? `$${top.priceDelta.toFixed(2)}` : "no extra cost",
      source: { kind: "derived", ref: state.learnerApplied ? "family-first ranking" : "soonest arrival" },
    });
    for (const from of informedBy) {
      graph.edges.push({ from, to: "recommendation", rel: "INFORMED", source: { kind: "derived", ref: "ranking" } });
    }
  }

  return { mode, graph, walk: w, informedBy };
}
