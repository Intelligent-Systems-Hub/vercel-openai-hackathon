import { readFileSync } from "node:fs";
import { join } from "node:path";

import casting from "@/fixtures/casting.json";

/** One recorded request/response pair, as written by the scrub script. */
export type Pair = {
  meta: { fullPath: string; requestDigest: string; ok: boolean; error?: string; note?: string };
  request: unknown;
  response: { status: number; content_type: string; body: string };
};

export type RoleName = keyof typeof casting.roles;

// Fixtures are read from disk at request time. On Vercel they reach the
// function bundle through `outputFileTracingIncludes` in next.config.ts.
// FIXTURE_ROOT overrides the location for runs started outside the app folder.
export const FIXTURE_ROOT = process.env.FIXTURE_ROOT ?? join(process.cwd(), "fixtures");

/** The fixture directory for an API path: "/v1/offers/flightShop" -> "v1_offers_flightShop". */
export const pathDir = (fullPath: string) => fullPath.replace(/^\//, "").replaceAll("/", "_");

export function loadPair(fullPath: string, digest: string): Pair {
  const file = join(FIXTURE_ROOT, "gds", pathDir(fullPath), `${digest}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Pair;
}

export function loadRole(role: RoleName): Pair {
  const { path, digest } = casting.roles[role];
  return loadPair(path, digest);
}

export { casting };
