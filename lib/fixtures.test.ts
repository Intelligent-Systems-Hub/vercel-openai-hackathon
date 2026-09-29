import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";
import { casting, FIXTURE_ROOT, loadPair, pathDir, type RoleName } from "@/lib/fixtures";

const castEntries = [
  ...Object.entries(casting.roles).map(([name, r]) => [name, r.path, r.digest] as const),
  ...casting.rebook.steps.map((s, i) => [`rebook ${i + 1} ${s.step}`, s.path, s.digest] as const),
  ["rebook failedFulfill", casting.rebook.failedFulfill.path, casting.rebook.failedFulfill.digest] as const,
];

describe("fixture corpus", () => {
  it("indexes 39 supplier pairs, each stored under its request digest", () => {
    const index = JSON.parse(readFileSync(join(FIXTURE_ROOT, "gds", "index.json"), "utf8"));
    expect(index.pairs).toHaveLength(39);
    for (const p of index.pairs) {
      expect(loadPair(p.fullPath, p.digest).meta.requestDigest).toBe(p.digest);
    }
  });

  it.each(castEntries)("casting %s points at a recorded pair", (_name, path, digest) => {
    expect(existsSync(join(FIXTURE_ROOT, "gds", pathDir(path), `${digest}.json`))).toBe(true);
    expect(loadPair(path, digest).meta.fullPath).toBe(path);
  });

  it("casts the rebook as six steps: old booking read and cancelled, new one created and ticketed", () => {
    expect(casting.rebook.steps.map((s) => s.step)).toEqual([
      "getBooking",
      "checkFlightTickets",
      "createBooking",
      "fulfillFlightTickets",
      "cancelBooking",
      "getBooking",
    ]);
    const { oldBookingCode, newBookingCode } = casting.rebook;
    for (const s of casting.rebook.steps.filter((s) => s.step !== "checkFlightTickets")) {
      const code = s.booking === "old" ? oldBookingCode : newBookingCode;
      const pair = loadPair(s.path, s.digest);
      expect(JSON.stringify(pair.request) + pair.response.body).toContain(code);
    }
    expect(loadPair(casting.rebook.failedFulfill.path, casting.rebook.failedFulfill.digest).meta.ok).toBe(false);
  });

  it("serves the non-supplier fixtures the demo replays", () => {
    for (const dir of ["weather_risk", "create_order", "capture", "refund"]) {
      expect(existsSync(join(FIXTURE_ROOT, dir))).toBe(true);
    }
  });
});

describe("GET /api/health", () => {
  it("reads the booked-trip recording from disk", async () => {
    const res = await GET();
    const role: RoleName = "seedOffer";
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      path: casting.roles[role].path,
      digest: casting.roles[role].digest,
      status: 200,
    });
  });
});
