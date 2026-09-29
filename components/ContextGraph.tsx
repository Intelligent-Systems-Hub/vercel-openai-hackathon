import type { ContextMode, RepairOption } from "@/lib/domain/types";
import type { ContextGraph as Graph, GraphNode, Walk } from "@/lib/graph/types";

import styles from "./graph.module.css";

export type ContextViewData = { mode: ContextMode; graph: Graph; walk: Walk; informedBy: string[] };

type Props = {
  context?: ContextViewData;
  options?: RepairOption[];
  busy?: boolean;
  onMode: (mode: ContextMode) => void;
};

// Fixed layout that follows the data model, so a node always appears in the
// same place as the conversation adds it: the trip at the top; its booking and
// every booked segment on the left; its party and members on the right, with
// what is fetched, derived or said beneath each member; the event top-left,
// attaching into the affected segment; the recommendation at the bottom.
const W = 106;
const H = 44;
const WIDE = 300;
const MEMBER_X = [234, 340, 446];

const SPINE = new Set(["event", "segment", "booking", "trip", "party"]);

/** Places every node the layout knows. Order within a kind follows the graph. */
function layout(nodes: GraphNode[], edges: Graph["edges"]): Map<string, [number, number]> {
  const at = new Map<string, [number, number]>();
  const memberX = new Map<string, number>();
  let seg = 0;
  let member = 0;
  let said = 0;
  const ownerOf = (id: string) => edges.find((e) => e.to === id && e.rel !== "INFORMED")?.from;

  for (const n of nodes) {
    if (n.kind === "traveler") memberX.set(n.id, MEMBER_X[member++] ?? MEMBER_X[2]);
  }
  for (const n of nodes) {
    switch (n.kind) {
      case "event":
        at.set(n.id, [8, 8]);
        break;
      case "trip":
        at.set(n.id, [226, 8]);
        break;
      case "booking":
        at.set(n.id, [64, 82]);
        break;
      case "party":
        at.set(n.id, [340, 82]);
        break;
      case "segment":
        at.set(n.id, [8 + (seg % 2) * 112, 156 + Math.floor(seg / 2) * 54]);
        seg++;
        break;
      case "traveler":
        at.set(n.id, [memberX.get(n.id)!, 156]);
        break;
      case "preference":
      case "requirement": {
        const x = memberX.get(ownerOf(n.id) ?? "") ?? MEMBER_X[2];
        const taken = [...at.values()].filter(([px, py]) => px === x && py >= 230).length;
        at.set(n.id, [x, 230 + taken * 54]);
        break;
      }
      case "entitlement": {
        const x = memberX.get(ownerOf(n.id) ?? "") ?? MEMBER_X[0];
        const taken = [...at.values()].filter(([px, py]) => px === x && py >= 230).length;
        at.set(n.id, [x, 230 + taken * 54]);
        break;
      }
      case "statement":
      case "learned":
      case "decision":
        at.set(n.id, [MEMBER_X[1], 230 + said++ * 54]);
        break;
      case "recommendation":
        at.set(n.id, [130, 392]);
        break;
    }
  }
  return at;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function ContextGraph({ context, options, busy, onMode }: Props) {
  const mode = context?.mode ?? "context";
  const nodes = context?.graph.nodes ?? [];
  const reached = new Set(context?.walk.reached ?? []);
  const informed = new Set(context?.informedBy ?? []);
  const unused = new Map((context?.walk.unused ?? []).map((u) => [u.nodeId, u.reason]));

  const placed = layout(nodes, context?.graph.edges ?? []);
  const widthOf = (n: GraphNode) => (n.kind === "recommendation" ? WIDE : W);

  const top = options?.[0];
  const coverage = context?.walk.coverage;
  const learner = Boolean(top?.reasoning) && mode === "context";

  const nodeClass = (n: GraphNode) => {
    const c = [styles.node, styles[n.kind]];
    if (SPINE.has(n.kind) && reached.has(n.id)) c.push(styles.hot);
    if (n.affected) c.push(styles.affected);
    if (informed.has(n.id) && !SPINE.has(n.kind)) c.push(styles.lit);
    if (unused.has(n.id)) c.push(styles.unused);
    if (mode === "booking" && !SPINE.has(n.kind) && n.kind !== "recommendation") c.push(styles.muted);
    return c.join(" ");
  };

  return (
    <section className={styles.panel} aria-label="Traveler context graph">
      <header className={styles.head}>
        <span>Traveler context graph</span>
        <div className={styles.toggle} role="group" aria-label="Ranking lens">
          <button aria-pressed={mode === "booking"} disabled={busy} onClick={() => onMode("booking")}>
            Booking only
          </button>
          <button aria-pressed={mode === "context"} disabled={busy} onClick={() => onMode("context")}>
            Traveler context on
          </button>
        </div>
      </header>

      <svg viewBox="0 0 560 446" className={styles.canvas} role="img" aria-label="Context graph">
        {context?.graph.edges.map((e) => {
          const a = placed.get(e.from);
          const b = placed.get(e.to);
          if (!a || !b) return null;
          const tone =
            e.rel === "INFORMED"
              ? styles.edgeGood
              : reached.has(e.from) && reached.has(e.to) && SPINE.has(nodes.find((n) => n.id === e.from)?.kind ?? "")
                ? styles.edgeHot
                : informed.has(e.from) || informed.has(e.to)
                  ? styles.edgeCtx
                  : "";
          const wa = widthOf(nodes.find((n) => n.id === e.from)!);
          const wb = widthOf(nodes.find((n) => n.id === e.to)!);
          return (
            <line
              key={`${e.from}-${e.rel}-${e.to}`}
              x1={a[0] + wa / 2}
              y1={a[1] + H / 2}
              x2={b[0] + wb / 2}
              y2={b[1] + H / 2}
              className={`${styles.edge} ${tone}`}
              data-rel={e.rel}
            />
          );
        })}
        {nodes.map((n) => {
          const at = placed.get(n.id);
          if (!at) return null;
          return (
            <g key={n.id} transform={`translate(${at[0]} ${at[1]})`} className={nodeClass(n)} data-node={n.id}>
              <rect width={widthOf(n)} height={H} rx={8} />
              <text x={8} y={18} className={styles.label}>
                {clip(n.label, n.kind === "recommendation" ? 44 : 17)}
              </text>
              {n.detail && (
                <text x={8} y={33} className={styles.sub}>
                  {clip(n.detail, n.kind === "recommendation" ? 48 : 20)}
                </text>
              )}
            </g>
          );
        })}
        {!nodes.some((n) => n.kind === "event") && (
          <text x={280} y={420} textAnchor="middle" className={styles.sub}>
            Fire the storm to see the walk
          </text>
        )}
      </svg>

      <div className={styles.inspector} data-testid="inspector">
        <div className={styles.status}>
          {mode === "booking"
            ? "Booking-only ranking · traveler context omitted"
            : coverage?.status === "degraded"
              ? `Context coverage degraded · ${coverage.reason}`
              : learner
                ? "Context-aware ranking · graph coverage complete"
                : "Traveler context on · nothing yet changes the ranking"}
        </div>
        {top && (
          <div className={styles.rec}>
            <span className={styles.recLabel}>Recommended</span>
            <strong data-testid="lens-recommendation">{top.title}</strong>
            <span>{top.priceDelta > 0 ? `$${top.priceDelta.toFixed(2)}` : "No extra cost"}</span>
          </div>
        )}
        {top && (
          <>
            <h4>Why this is first</h4>
            <ul className={styles.why}>
              {learner
                ? top.reasoning!.because.map((b) => (
                    <li key={b.text}>
                      {b.text}
                      {b.path && <span className={styles.path}>{b.path.join(" → ")}</span>}
                    </li>
                  ))
                : [
                    <li key="soonest">It gets you there soonest.</li>,
                    <li key="none">{mode === "booking" ? "No traveler context was used." : "No traveler fact changed the order."}</li>,
                  ]}
            </ul>
          </>
        )}
        {context && context.walk.unused.length > 0 && (
          <>
            <h4>Known, not used</h4>
            <ul className={styles.unusedList} data-testid="unused">
              {context.walk.unused.map((u) => (
                <li key={u.nodeId}>
                  <strong>{u.label}</strong> {u.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
