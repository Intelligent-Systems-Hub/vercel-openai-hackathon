import type { HotelProperty, HotelQuote, Offer, Segment } from "./types";

// Parsers for the three supplier responses the repair reads. Each tolerates
// missing pieces by skipping them: a malformed offer is dropped, never guessed.

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (v == null ? "" : String(v));
const hhmm = (t: unknown) => str(t).slice(0, 5);

/** Flight-shop response -> offers, resolving offer -> journeys -> flights. */
export function parseShop(body: unknown): Offer[] {
  const shop = obj(body);
  const flights = new Map(arr(shop.flights).map((f) => [str(obj(f).id), obj(f)]));
  const journeys = new Map(arr(shop.journeys).map((j) => [str(obj(j).id), obj(j)]));

  const offers: Offer[] = [];
  for (const raw of arr(shop.offers)) {
    const offer = obj(raw);
    // booking class per flight, from the fare breakdown
    const klass = new Map<string, string>();
    for (const item of arr(offer.items))
      for (const fare of arr(obj(item).fares))
        for (const comp of arr(obj(fare).fareComponents))
          for (const seg of arr(obj(comp).segmentDetails)) {
            const s = obj(seg);
            if (s.flightRef) klass.set(str(s.flightRef), str(s.bookingClassCode) || "Y");
          }

    const segments: Segment[] = [];
    for (const jref of arr(offer.journeyRefs))
      for (const fref of arr(journeys.get(str(jref))?.flightRefs)) {
        const f = flights.get(str(fref));
        if (!f) continue;
        segments.push({
          carrier: str(f.marketingAirlineCode),
          number: str(f.marketingFlightNumber),
          from: str(f.departureAirportCode),
          to: str(f.arrivalAirportCode),
          departDate: str(f.departureDate),
          departTime: hhmm(f.departureTime),
          arriveDate: str(f.arrivalDate) || str(f.departureDate),
          arriveTime: hhmm(f.arrivalTime),
          bookingClass: klass.get(str(fref)) ?? "Y",
        });
      }

    const price = Number(obj(offer.totalPrice).amount);
    if (segments.length && Number.isFinite(price)) {
      offers.push({
        offerId: str(offer.id),
        price,
        currency: str(obj(offer.totalPrice).currencyCode) || "USD",
        segments,
      });
    }
  }
  return offers;
}

/** Hotel-search response -> properties, with whether each lists a crib. */
export function parseHotelSearch(body: unknown): HotelProperty[] {
  return arr(obj(body).hotels)
    .map((h) => obj(obj(h).hotel))
    .filter((e) => e.hotelCode)
    .map((e) => ({
      hotelCode: str(e.hotelCode),
      name: str(e.hotelName),
      city: str(obj(e.address).cityName),
      crib: arr(e.amenities).some((a) => typeof a === "string" && a.toLowerCase().includes("crib")),
    }));
}

export type RateQuote = Pick<
  HotelQuote,
  "room" | "ratePlan" | "rateKey" | "nightly" | "total" | "currency" | "cribCharge"
>;

/**
 * The first bookable room on a rates response. Refuses rates for a different
 * property than the one asked about: better no quote than someone else's.
 */
export function parseRates(body: unknown, expectedHotelCode: string): RateQuote | undefined {
  const priced = obj(body);
  if (priced.hotelCode && str(priced.hotelCode) !== expectedHotelCode) return undefined;
  for (const room of arr(priced.rooms)) {
    for (const plan of arr(obj(room).ratePlans)) {
      const p = obj(plan);
      if (!p.rateKey) continue;
      const details = obj(p.rateDetails);
      const crib = arr(details.roomExtras)
        .map(obj)
        .find((x) => str(x.description).toLowerCase().includes("crib"));
      const nightly = Number(details.averageNightlyRate) || 0;
      return {
        room: str(obj(room).roomTypeName),
        ratePlan: str(p.ratePlanName),
        rateKey: str(p.rateKey),
        nightly,
        total: Number(details.approxTotalPrice) || nightly,
        currency: str(details.currencyCode) || "USD",
        cribCharge: crib ? Number(crib.amount) || 0 : null,
      };
    }
  }
  return undefined;
}
