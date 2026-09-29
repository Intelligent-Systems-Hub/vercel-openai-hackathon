import { Redis } from "@upstash/redis";

import type { ExecuteResult } from "@/lib/domain/execute";
import type { Approval } from "@/lib/domain/gate";
import { buildSeedTrip } from "@/lib/domain/seed";
import { demoDepart } from "@/lib/replay";
import { addDays } from "@/lib/replay/shift";
import type { CallLine } from "@/lib/actions/call";
import type { HotelPolicy, RefundAsk } from "@/lib/domain/policy";
import type { LedgerEntry } from "@/lib/domain/settle";
import type { ContextMode, RepairCase, RepairOption, TravelerMemory, Trip } from "@/lib/domain/types";

// Everything the demo remembers between requests, under one session key. On
// Vercel, consecutive requests can land on different instances, so the state
// must live in Redis; the in-memory store is for local runs and tests only.

export type TripState = {
  trip: Trip;
  /** Set by the director's storm button: the weather alert is live for this trip. */
  storm?: boolean;
  repairCase?: RepairCase;
  options?: RepairOption[];
  learnerApplied?: boolean;
  /** How the presenter's lens ranks: with the traveler context graph (default) or the booking alone. */
  contextMode?: ContextMode;
  /**
   * The learner switch. Off (the default), what the agent learned from the
   * traveler's choices is written to the graph but not used; on, it shapes
   * the ranking. Nothing else changes between the two.
   */
  learner?: boolean;
  approvals: Record<string, Approval>;
  rebook?: { approvalId: string; optionId: RepairOption["id"]; result: ExecuteResult };
  /** The trip as booked before the rebook: what the storm hit and the recommendation was made on. */
  replaced?: Trip;
  ledger: LedgerEntry[];
  /** Channels the new itinerary has already gone out on, so each is sent once. */
  notified?: ("email" | "sms")[];
  /** The destination hotel's policy as the agent read it, and the refund it may ask for. */
  policy?: HotelPolicy & { ask: RefundAsk };
  /** The refund request to the destination hotel: made once, by email or by phone. */
  refund?: {
    route: "email" | "call";
    hotel: string;
    amountCents: number;
    framing: string;
    to: string;
    /** Whether the email left or the call was placed; false when composed only (live actions off). */
    sent: boolean;
    reason?: string;
    simulated?: boolean;
    callSid?: string;
    transcript?: CallLine[];
    /** What the hotel said, when a call records it. */
    outcome?: string;
  };
  /** What the agent on a live call is told to say (read by the voice webhook). */
  callBrief?: string;
  /** The trip summary email, sent once. */
  summary?: { to: string; sent: boolean; reason?: string };
};

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemoryStore implements Store {
  private data = new Map<string, string>();
  async get<T>(key: string) {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown) {
    this.data.set(key, JSON.stringify(value));
  }
  async del(key: string) {
    this.data.delete(key);
  }
}

class RedisStore implements Store {
  constructor(private redis: Redis) {}
  async get<T>(key: string) {
    return ((await this.redis.get<T>(key)) ?? undefined) as T | undefined;
  }
  async set(key: string, value: unknown) {
    await this.redis.set(key, value);
  }
  async del(key: string) {
    await this.redis.del(key);
  }
}

export class StateConfigError extends Error {}

let shared: Store | undefined;

/**
 * Redis credentials under either naming: UPSTASH_* when set by hand, KV_* when
 * the Vercel Marketplace integration injects them.
 */
export function redisConfig(env: Record<string, string | undefined>): { url: string; token: string } | undefined {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : undefined;
}

/** The store for this deployment. Refuses to run on Vercel without Redis. */
export function getStore(env: Record<string, string | undefined> = process.env): Store {
  const redis = redisConfig(env);
  if (!redis && (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "production")) {
    throw new StateConfigError(
      "Redis is required on Vercel (UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_URL/_TOKEN): in-memory state is lost between requests",
    );
  }
  if (env === process.env && shared) return shared;
  const store = redis ? new RedisStore(new Redis(redis)) : new MemoryStore();
  if (env === process.env) shared = store;
  return store;
}

/** How far after trip 1 the family's next trip departs. */
export const NEXT_TRIP_DAYS = 28;

/** One traveler's demo: their trip state, plus memory that survives a trip reset. */
export class Session {
  constructor(
    readonly id: string,
    private store: Store = getStore(),
    private depart?: string,
  ) {}

  private tripKey = () => `trip:${this.id}`;
  private memoryKey = () => `memory:${this.id}`;

  async state(): Promise<TripState> {
    const found = await this.store.get<TripState>(this.tripKey());
    if (found) return found;
    const fresh: TripState = { trip: buildSeedTrip(this.depart), approvals: {}, ledger: [] };
    await this.save(fresh);
    return fresh;
  }

  async save(state: TripState): Promise<void> {
    await this.store.set(this.tripKey(), state);
  }

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Read, change and save the trip state, one change at a time. The model can
   * call several tools in one step; without this, two of them would each save
   * over the other's change.
   */
  update<R>(change: (state: TripState) => R | Promise<R>): Promise<R> {
    const run = this.queue.then(async () => {
      const state = await this.state();
      const result = await change(state);
      await this.save(state);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async memory(): Promise<TravelerMemory> {
    return (await this.store.get<TravelerMemory>(this.memoryKey())) ?? { facts: [] };
  }

  async saveMemory(memory: TravelerMemory): Promise<void> {
    await this.store.set(this.memoryKey(), memory);
  }

  /** Back to the booked trip, keeping what the traveler told us (demo step 4). */
  async resetTrip(): Promise<void> {
    await this.store.del(this.tripKey());
  }

  /**
   * The family's next trip, four weeks on, staying at a different hotel. What
   * the agent learned carries over; the trip does not.
   */
  async nextTrip(): Promise<void> {
    const depart = addDays(this.depart ?? demoDepart(), NEXT_TRIP_DAYS);
    await this.save({ trip: buildSeedTrip(depart, "trip-2", "calgary"), approvals: {}, ledger: [] });
  }

  /** Back to the start: trip and memory (between rehearsals). */
  async resetAll(): Promise<void> {
    await this.store.del(this.tripKey());
    await this.store.del(this.memoryKey());
  }
}
