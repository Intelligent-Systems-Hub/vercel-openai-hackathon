import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURE_ROOT, type Pair } from "@/lib/fixtures";

import { requestDigest } from "./digest";

export type MatchKind = "exact" | "fallback";

export class ReplayMiss extends Error {
  constructor(readonly path: string) {
    super(`no recorded response for ${path}`);
    this.name = "ReplayMiss";
  }
}

let index: Map<string, Pair[]> | undefined;

/** Every recorded pair, grouped by API path. Loaded once per process. */
function pairsByPath(): Map<string, Pair[]> {
  if (index) return index;
  index = new Map();
  const root = join(FIXTURE_ROOT, "gds");
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(root, dir.name))) {
      const pair = JSON.parse(readFileSync(join(root, dir.name, file), "utf8")) as Pair;
      const list = index.get(pair.meta.fullPath) ?? [];
      list.push(pair);
      index.set(pair.meta.fullPath, list);
    }
  }
  // Stable order, so a tie always resolves the same way on every machine.
  for (const list of index.values()) list.sort((a, b) => a.meta.requestDigest.localeCompare(b.meta.requestDigest));
  return index;
}

/** Flatten to "a.b[0].c" -> scalar, for overlap scoring. */
function flatten(node: unknown, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(node)) node.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else if (node !== null && typeof node === "object")
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  else out.set(prefix, node);
  return out;
}

/**
 * The recording for `request` on `path` (dates already on the capture
 * calendar). Exact digest first; otherwise the same-path recording sharing the
 * most fields, successful recordings preferred. No shared field, or no
 * recording for the path at all, is a miss: replay never invents a response.
 */
export function match(path: string, request: unknown): { pair: Pair; kind: MatchKind } {
  const candidates = pairsByPath().get(path);
  if (!candidates?.length) throw new ReplayMiss(path);

  const digest = requestDigest(request);
  const exact = candidates.find((p) => p.meta.requestDigest === digest);
  if (exact) return { pair: exact, kind: "exact" };

  const wanted = flatten(request);
  let best: { pair: Pair; score: number } | undefined;
  for (const pair of candidates) {
    let shared = 0;
    for (const [k, v] of flatten(pair.request)) if (wanted.get(k) === v) shared++;
    if (shared === 0) continue;
    const score = shared * 2 + (pair.meta.ok ? 1 : 0);
    if (!best || score > best.score) best = { pair, score };
  }
  if (!best) throw new ReplayMiss(path);
  return { pair: best.pair, kind: "fallback" };
}
