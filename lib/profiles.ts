import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURE_ROOT } from "@/lib/fixtures";

// The traveler profile system: preferences and entitlements that belong to a
// person, not to any booking. The context graph fetches from it by traveler
// id during the walk. In the demo it is a file; in production, a profile or
// loyalty service.

export type Preference = { kind: string; value: string; label: string };
export type Entitlement = { program: string; tier: string; redemption?: string };
export type Profile = { preferences: Preference[]; entitlements: Entitlement[] };

/** Looks a traveler up by id. Returns undefined when they have no profile; throws when the store cannot answer. */
export type ProfileStore = (travelerId: string) => Profile | undefined;

let cache: Record<string, Profile> | undefined;

export const profileStore: ProfileStore = (travelerId) => {
  cache ??= JSON.parse(readFileSync(join(FIXTURE_ROOT, "profiles.json"), "utf8")) as Record<string, Profile>;
  const found = cache[travelerId];
  return found && typeof found === "object" ? found : undefined;
};
