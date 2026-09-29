/** Shortest connection a family can make at the hub. */
export const MINIMUM_CONNECT_MINUTES = 45;

/**
 * How late the storm makes the inbound flight. The weather recording says a
 * storm is coming, not by how much, so the demo stages the delay: 90 minutes
 * turns the booked 97-minute connection into 7.
 */
export const STAGED_DELAY_MINUTES = 90;

/**
 * A one-number flight that takes this much longer than the quickest flight on
 * the route is a through-service with stops, not a non-stop.
 */
export const THROUGH_SERVICE_FACTOR = 1.6;

export const HOTEL_SEARCH_RADIUS_MILES = 5;
export const HOTEL_MAX_RESULTS = 5;

/** The account code the recorded hotel searches were made under (scrubbed). */
export const POINT_OF_SALE = "DM01";

export const CURRENCY = "USD";
