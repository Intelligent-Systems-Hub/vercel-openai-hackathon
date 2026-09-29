import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIXTURE_ROOT } from "@/lib/fixtures";

import { hotelPolicy, RECORDED_DELTA_PENALTY, refundAsk, refundEmail } from "./policy";
import { buildSeedTrip } from "./seed";

const DEMO = "2026-09-29";

describe("hotel policy", () => {
  it("quotes the recorded cancellation terms for the recorded hotel, verbatim", () => {
    const file = join(FIXTURE_ROOT, "gds/v1_hotels_getHotelRates/9f7dec569e21ae5f90b85a8b7ed4ec979536c16005344fb3b358ba94cf33099e.json");
    const { request, response } = JSON.parse(readFileSync(file, "utf8"));
    const body = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    expect(request.hotelCode).toBe("100130144");
    expect(JSON.stringify(body)).toContain(`"cancelPenalties":[${JSON.stringify(RECORDED_DELTA_PENALTY)}]`);
    expect(RECORDED_DELTA_PENALTY).toEqual({ refundable: false, description: "UP TO 01 DAYS AFTER BOOKING" });
  });

  it("labels the fictional lodge's policy as demo content, and reads it as clear", () => {
    expect(hotelPolicy(buildSeedTrip(DEMO))).toMatchObject({ hotel: "Bow River Lodge", clarity: "clear", source: expect.stringMatching(/demo content/) });
    expect(hotelPolicy(buildSeedTrip(DEMO, "trip-2", "calgary"))).toMatchObject({ clarity: "unclear" });
  });

  it("asks for the missed first night, framed as requested, and says how much of the hub room it would offset", () => {
    const trip = buildSeedTrip(DEMO);
    expect(refundAsk(trip).framing).toBe("$520.00 requested for the missed night at Bow River Lodge, if the hotel approves.");
    const ask = refundAsk(trip, { name: "Sheraton", total: 401.79 });
    expect(ask).toMatchObject({ amountCents: 52000, night: DEMO, offsets: { amountCents: 40179 } });
    const email = refundEmail(trip, ask, { hub: "ORD", was: "WS 1611", now: "UA 764", arrives: "2026-09-30" });
    expect(email.subject).toBe(`Refund request: missed first night, Maya, Sam, Nora, check-in ${DEMO}`);
    expect(email.text).toContain("A storm at ORD broke their connection (WS 1611)");
    expect(email.text).toContain("we request a refund of the first night, $520.00");
  });
});
