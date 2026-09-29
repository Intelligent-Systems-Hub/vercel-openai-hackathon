import type { RepairOption } from "./types";

/**
 * What the traveler approved, as stored on the server when they tapped
 * Approve. Tools look it up by id; they never take an amount or an "approved"
 * flag from the model.
 */
export type Approval = {
  id: string;
  optionId: RepairOption["id"];
  /** The amount shown on the approval sheet, in cents. */
  amountCents: number;
  nonce: string;
  used: boolean;
  /** The traveler's yes also covered asking the destination hotel for the missed night back. */
  includesRefund?: boolean;
};

export type GateResult = { allowed: true; amountCents: number } | { allowed: false; reason: string };

/** An option's price in cents. An unreadable price counts as a charge, never as free. */
export function priceCents(option: RepairOption): number | undefined {
  if (option.roomUnpriced) return undefined;
  const n = Number(option.priceDelta);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

/**
 * The money gate. Nothing is booked or charged unless the traveler approved
 * THIS option at THIS price, and each approval works once.
 */
export function checkGate(option: RepairOption | undefined, approval: Approval | undefined): GateResult {
  if (!option) return { allowed: false, reason: "no option has been chosen" };
  if (!approval) return { allowed: false, reason: "the traveler has not approved this change" };
  if (approval.used) return { allowed: false, reason: "that approval has already been used" };
  if (approval.optionId !== option.id) {
    return { allowed: false, reason: "the approval is for a different option" };
  }
  const cents = priceCents(option);
  if (cents === undefined) {
    return { allowed: false, reason: "the price could not be read, so it cannot be treated as free" };
  }
  if (cents !== approval.amountCents) {
    return { allowed: false, reason: "the price changed since the traveler approved it" };
  }
  return { allowed: true, amountCents: cents };
}
