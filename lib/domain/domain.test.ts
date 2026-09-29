import { describe, expect, it } from "vitest";

import { casting, loadRole } from "@/lib/fixtures";
import { addDays } from "@/lib/replay/shift";

import { detect } from "./detect";
import { parseHotelSearch, parseRates, parseShop } from "./parse";
import { BOOKED, buildSeedTrip, TRAVELERS } from "./seed";
import { hotelRates, searchHotels, shopFlights, weatherAlert } from "./supplier";

const DEMO = "2026-09-29";
const body = (role: Parameters<typeof loadRole>[0]) => JSON.parse(loadRole(role).response.body);
const flight = (s: { carrier: string; number: string }) => `${s.carrier}${s.number}`;

describe("parse", () => {
  it("resolves shop offers into priced segments", () => {
    const offers = parseShop(body("sameDayShop"));
    const ua = offers.find((o) => o.segments.length === 1 && flight(o.segments[0]) === "UA1156");
    expect(ua).toMatchObject({
      price: 357.6,
      currency: "USD",
      segments: [{ from: "ORD", to: "YYC", departDate: "2026-07-30", departTime: "19:45", arriveTime: "22:37" }],
    });
    expect(ua!.segments[0].bookingClass).toMatch(/^[A-Z]$/);
  });

  it("reads which hub hotels list a crib", () => {
    const hotels = parseHotelSearch(body("hubHotelSearch"));
    expect(hotels[0]).toMatchObject({ hotelCode: "100033334", crib: true });
    expect(hotels[0].name).toMatch(/Sheraton/);
  });

  it("quotes the crib-hotel room: $401.79, crib free", () => {
    expect(parseRates(body("cribRates"), "100033334")).toMatchObject({
      nightly: 401.79,
      total: 401.79,
      currency: "USD",
      cribCharge: 0,
    });
  });

  it("refuses rates that belong to a different property", () => {
    expect(parseRates(body("cribRates"), "100161724")).toBeUndefined();
  });
});

describe("supplier calls match their recordings exactly on demo day", () => {
  it("shops the onward leg from the hub, same day and next morning", () => {
    const hub = { from: "ORD", to: "YYC" };
    expect(shopFlights([{ ...hub, date: DEMO }], TRAVELERS, DEMO).call).toMatchObject({
      kind: "exact",
      digest: casting.roles.sameDayShop.digest,
    });
    expect(shopFlights([{ ...hub, date: addDays(DEMO, 1) }], TRAVELERS, DEMO).call).toMatchObject({
      kind: "exact",
      digest: casting.roles.nextMorningShop.digest,
    });
  });

  it("searches and prices a room at the hub", () => {
    expect(searchHotels("ORD", DEMO, DEMO).call.kind).toBe("exact");
    const { rate, call } = hotelRates("100033334", DEMO, { adults: 2, children: 1, childAge: 1 }, DEMO);
    expect(call.kind).toBe("exact");
    expect(rate?.total).toBe(401.79);
  });

  it("shops the booked round trip", () => {
    const { call } = shopFlights(
      [
        { from: "JFK", to: "YYC", date: DEMO },
        { from: "YYC", to: "JFK", date: addDays(DEMO, 5) },
      ],
      TRAVELERS,
      DEMO,
    );
    expect(call).toMatchObject({ kind: "exact", digest: casting.roles.seedOffer.digest });
  });
});

describe("seed trip", () => {
  const trip = buildSeedTrip(DEMO);

  it("is two adults and an infant, five nights, on the demo dates", () => {
    expect(trip.travelers.map((t) => t.type)).toEqual(["adult", "adult", "infant"]);
    expect(trip.hotel).toMatchObject({ checkin: DEMO, checkout: addDays(DEMO, 5), nightly: 520 });
  });

  it("flies JFK -> hub -> YYC out and back on recorded flights", () => {
    expect(trip.segments.map((s) => `${flight(s)} ${s.from}-${s.to} ${s.departDate} ${s.departTime}`)).toEqual([
      `AA3321 JFK-ORD ${DEMO} 13:59`,
      `WS1611 ORD-YYC ${DEMO} 17:30`,
      `AA1633 YYC-ORD ${addDays(DEMO, 5)} 07:00`,
      `AA4371 ORD-JFK ${addDays(DEMO, 5)} 12:50`,
    ]);
    expect(trip.outboundLegs).toBe(2);
    expect(trip.segments[0].to).toBe(BOOKED.hub);
  });

  it("carries the recorded round-trip price for the party", () => {
    expect(trip.flightPrice).toBe(1603.95);
  });
});

describe("detect (S1)", () => {
  const trip = buildSeedTrip(DEMO);
  const storm = weatherAlert("ORD");

  it("opens a case when the storm delay leaves under 45 minutes to connect", () => {
    const result = detect(trip, storm);
    expect(result.opened).toBe(true);
    expect(result.repairCase).toMatchObject({
      hub: "ORD",
      bookedConnectionMinutes: 97,
      delayMinutes: 90,
      connectionLeftMinutes: 7,
      minimumConnectMinutes: 45,
    });
  });

  it("does not open a case when the connection still works", () => {
    expect(detect(trip, storm, undefined, 30)).toMatchObject({ opened: false });
  });

  it("returns the open case instead of opening a second one", () => {
    const first = detect(trip, storm);
    const again = detect(trip, storm, first.repairCase);
    expect(again.opened).toBe(false);
    expect(again.repairCase).toBe(first.repairCase);
  });

  it("ignores weather where the trip does not connect, or no alert at all", () => {
    expect(detect(trip, { airport: "DFW", risk: "high", summary: "" }).opened).toBe(false);
    expect(detect(trip, undefined).opened).toBe(false);
    expect(detect(trip, { ...storm!, risk: "low" }).opened).toBe(false);
  });
});
