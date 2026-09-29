/** One flight on an itinerary. Dates are YYYY-MM-DD, times HH:MM, both local. */
export type Segment = {
  carrier: string;
  number: string;
  from: string;
  to: string;
  departDate: string;
  departTime: string;
  arriveDate: string;
  arriveTime: string;
  bookingClass: string;
};

export type Traveler = {
  id: string;
  name: string;
  type: "adult" | "infant";
  /** Whole years; infants are 0 or 1. */
  age: number;
};

export type HotelStay = {
  name: string;
  city: string;
  checkin: string;
  checkout: string;
  nightly: number;
};

export type Trip = {
  id: string;
  bookingCode: string;
  travelers: Traveler[];
  /** Outbound legs, then return legs, in flight order. */
  segments: Segment[];
  /** How many of `segments` are the outbound journey. */
  outboundLegs: number;
  hotel: HotelStay;
  flightPrice: number;
  currency: string;
};

/** A priced itinerary from a flight shop. */
export type Offer = {
  offerId: string;
  price: number;
  currency: string;
  segments: Segment[];
};

/** A property found near an airport. */
export type HotelProperty = {
  hotelCode: string;
  name: string;
  city: string;
  crib: boolean;
};

/** A quoted room at a property, for the party and night asked about. */
export type HotelQuote = HotelProperty & {
  airport: string;
  checkin: string;
  checkout: string;
  room: string;
  ratePlan: string;
  rateKey: string;
  nightly: number;
  total: number;
  currency: string;
  /** What the property says a crib costs; null when it lists no price. */
  cribCharge: number | null;
};

export type WeatherAlert = { airport: string; risk: string; summary: string };

/** Something the traveler told the agent, kept across repairs. */
export type MemoryFact =
  | { kind: "travels_with_infant"; text: string; childName?: string }
  /** Learned from what the traveler did: they chose `chose` over the recommended `over`, and said why. */
  | { kind: "learned_choice"; text: string; chose: OptionId; over: OptionId; childName?: string }
  /** The traveler said yes to asking the destination hotel for a missed night back; `text` is why. */
  | { kind: "refund_decision"; text: string; hotel: string; amountCents: number; route: "email" | "call"; childName?: string }
  | { kind: "note"; text: string };

export type TravelerMemory = { facts: MemoryFact[] };

export type OptionId = "later-connection" | "overnight-at-hub";

/** One reason, and the context-graph path from the event that supports it. */
export type Reason = { text: string; path?: string[] };

/** Why the learner put an option first, in the traveler's terms. */
export type Reasoning = { headline: string; because: Reason[]; tradeoff: string };

/** "context": rank with the traveler context graph; "booking": the booking alone. */
export type ContextMode = "context" | "booking";

/** One way out of a broken connection, carrying the real flights it books. */
export type RepairOption = {
  id: OptionId;
  title: string;
  /** The whole new itinerary: kept legs plus the replacement. */
  segments: Segment[];
  /** Only the legs that change, paired with what they replace. */
  changed: { was: Segment; now: Segment }[];
  /** What the traveler pays on top of what they already paid. */
  priceDelta: number;
  priceNote?: string;
  /** How much later than booked they reach the destination. */
  arrivalDeltaMinutes: number;
  familyFit: number;
  familyCapable: boolean;
  familyAware?: boolean;
  /** Set until a real room rate has been quoted for an overnight. */
  roomUnpriced?: boolean;
  hotel?: HotelQuote;
  hotelError?: string;
  overnightAt?: string;
  arrivesOn: string;
  rationale: string[];
  accommodations: string[];
  tradeoff: string;
  reasoning?: Reasoning;
  rank?: number;
};

/** A broken connection, measured off the booked itinerary. */
export type RepairCase = {
  id: string;
  tripId: string;
  hub: string;
  alert: WeatherAlert;
  /** How late the inbound flight is assumed to land. */
  delayMinutes: number;
  /** Booked time between landing at the hub and the onward departure. */
  bookedConnectionMinutes: number;
  /** What is left once the delay is taken out. */
  connectionLeftMinutes: number;
  minimumConnectMinutes: number;
  inbound: Segment;
  onward: Segment;
  /** Reference keys the event carries: which booking, which booked item. */
  bookingLocator: string;
  affectedItemId: string;
};
