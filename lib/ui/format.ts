import type { Segment } from "@/lib/domain/types";

/** 138 -> "2h 18m later"; 913 -> "15h 13m later"; 0 -> "on time". */
export function lateBy(minutes: number): string {
  if (minutes <= 0) return "on time";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h ? `${h}h ` : ""}${m ? `${m}m` : ""}`.trim() + " later";
}

export function money(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function cents(amountCents: number): string {
  return money(amountCents / 100);
}

/** "2026-09-30" -> "Wed 30 Sep". */
export function day(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export const flightNo = (s: Segment) => `${s.carrier} ${s.number}`;

/** A day marker when a flight lands on a later date than it left. */
export function nextDayMark(s: Segment): string {
  const diff = Math.round((Date.parse(s.arriveDate) - Date.parse(s.departDate)) / 86_400_000);
  return diff > 0 ? `+${diff}` : "";
}
