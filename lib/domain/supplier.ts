import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURE_ROOT } from "@/lib/fixtures";
import { replay } from "@/lib/replay";
import { addDays } from "@/lib/replay/shift";

import { CURRENCY, HOTEL_MAX_RESULTS, HOTEL_SEARCH_RADIUS_MILES, POINT_OF_SALE } from "./constants";
import { parseHotelSearch, parseRates, parseShop, type RateQuote } from "./parse";
import type { HotelProperty, Offer, Traveler, WeatherAlert } from "./types";

// The supplier calls the repair makes. Each builds the request exactly as the
// recorded one was made, so replay answers with an exact match, and reports how
// it matched so the activity rail can say so.

export type SupplierCall = { path: string; digest: string; kind: string };

const passengerTypes = (travelers: Traveler[]) =>
  travelers.map((t) => ({ passengerTypeCode: t.type === "infant" ? "INF" : "ADT" }));

const FARE = { currencyCode: CURRENCY, cabin: { name: "Economy" } };

type Journey = { from: string; to: string; date: string };

export function shopFlights(journeys: Journey[], travelers: Traveler[], depart?: string) {
  const request = {
    journeys: journeys.map((j) => ({
      departureLocation: { airportCode: j.from },
      arrivalLocation: { airportCode: j.to },
      departureDate: j.date,
    })),
    travelers: passengerTypes(travelers),
    fare: FARE,
  };
  const res = replay("/v1/offers/flightShop", request, depart);
  return { offers: parseShop(res.body) as Offer[], call: res as SupplierCall };
}

export function searchHotels(airport: string, night: string, depart?: string) {
  const request = {
    currencyCode: CURRENCY,
    radiusInMiles: HOTEL_SEARCH_RADIUS_MILES,
    checkInDate: night,
    checkOutDate: addDays(night, 1),
    maxResults: HOTEL_MAX_RESULTS,
    referencePoint: { type: "Airport", value: airport },
    pos: { source: { pseudoCityCode: POINT_OF_SALE } },
  };
  const res = replay("/v1/hotels/hotelSearch", request, depart);
  return { hotels: parseHotelSearch(res.body) as HotelProperty[], call: res as SupplierCall };
}

export function hotelRates(
  hotelCode: string,
  night: string,
  party: { adults: number; children: number; childAge: number },
  depart?: string,
) {
  const request = {
    hotelCode,
    checkInDate: night,
    checkOutDate: addDays(night, 1),
    numberOfAdults: party.adults,
    numberOfChildren: party.children,
    childAges: Array(party.children).fill(party.childAge),
  };
  const res = replay("/v1/hotels/getHotelRates", request, depart);
  return { rate: parseRates(res.body, hotelCode) as RateQuote | undefined, call: res as SupplierCall };
}

/** The recorded weather alert for an airport, if there is one. */
export function weatherAlert(airport: string): WeatherAlert | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(FIXTURE_ROOT, "weather_risk", `${airport}.json`), "utf8"));
    return { airport: String(raw.airport), risk: String(raw.risk), summary: String(raw.summary) };
  } catch {
    return undefined;
  }
}
