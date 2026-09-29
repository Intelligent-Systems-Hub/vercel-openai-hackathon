/**
 * The options the traveler is offered. With the booking alone the agent is a
 * plain rebooker: it offers only its top pick. With traveler context it shows
 * the alternatives too, so the traveler can choose against it.
 */
export function offered<T>(options: T[] | undefined, mode: string | undefined): T[] {
  return mode === "booking" ? (options ?? []).slice(0, 1) : (options ?? []);
}
