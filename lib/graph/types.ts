// The traveler context graph, shaped like the context-graph data model:
//
//   ChangeEvent  one-shot, carries reference keys (booking locator + affected item)
//   Trip ─OWNS→ Booking ─CONTAINS_SEGMENT→ Segment      standing, operational
//   Trip ─OWNS→ Party ─MEMBER→ Traveler                  standing, who is flying
//   Traveler ─HAS_PREFERENCE/HAS_ENTITLEMENT→ …          external, fetched by traveler id
//   Traveler ─REQUIRES→ …                                derived by rule, never stored
//   Learned ─SAID_ABOUT→ Traveler                        learned from a choice the traveler made
//   Decision ─SAID_ABOUT→ Traveler, ─BECAUSE→ Learned     a refund the traveler chose to request, and why
//   … ─INFORMED→ Recommendation                          output
//
// It is rebuilt from session state on every read, never stored, so it cannot
// drift from the trip it describes.

export type NodeKind =
  | "event"
  | "trip"
  | "booking"
  | "segment"
  | "party"
  | "traveler"
  | "requirement"
  | "statement"
  | "learned"
  | "decision"
  | "preference"
  | "entitlement"
  | "recommendation";

/** Where a fact came from. Every node and edge carries one. */
export type Source =
  | { kind: "event"; ref: string }
  | { kind: "booking"; ref: string }
  | { kind: "profile"; ref: string }
  | { kind: "conversation"; ref: string }
  | { kind: "derived"; ref: string };

export type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  detail?: string;
  source: Source;
  /** Reference keys: what other records find this one by. */
  keys?: Record<string, string>;
  /** Set on the segment the event names. */
  affected?: boolean;
};

export type Relation =
  | "AFFECTS"
  | "OWNS"
  | "CONTAINS_SEGMENT"
  | "MEMBER"
  | "REQUIRES"
  | "SAID_ABOUT"
  | "BECAUSE"
  | "HAS_PREFERENCE"
  | "HAS_ENTITLEMENT"
  | "INFORMED";

export type GraphEdge = { from: string; to: string; rel: Relation; source: Source };

export type ContextGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Data the graph could not get, e.g. a profile lookup that failed. Degrades coverage. */
  issues: string[];
};

/** A fact the walk reached, and the path from the event that reached it. */
export type Fact = {
  nodeId: string;
  kind: NodeKind;
  label: string;
  /** Node labels from the event to this fact. */
  path: string[];
};

export type UnusedFact = Fact & { reason: string };

export type Coverage = { status: "complete" } | { status: "degraded"; reason: string };

export type Walk = {
  /** Every node the walk touched, in order. */
  reached: string[];
  /** Facts that bear on this repair. */
  applicable: Fact[];
  /** Facts that exist but do not bear on it, with why. */
  unused: UnusedFact[];
  coverage: Coverage;
};
