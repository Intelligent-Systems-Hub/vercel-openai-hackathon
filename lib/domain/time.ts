/** Whole minutes from `a` to `b`, both "YYYY-MM-DDTHH:MM" local times. */
export function minutesBetween(a: string, b: string): number {
  const ms = Date.parse(`${b.slice(0, 16)}:00Z`) - Date.parse(`${a.slice(0, 16)}:00Z`);
  return Math.round(ms / 60_000);
}

/** "YYYY-MM-DDTHH:MM" plus `minutes`. */
export function addMinutes(at: string, minutes: number): string {
  return new Date(Date.parse(`${at.slice(0, 16)}:00Z`) + minutes * 60_000).toISOString().slice(0, 16);
}
