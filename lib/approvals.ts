import { randomUUID } from "node:crypto";

import { checkGate, priceCents, type Approval, type GateResult } from "@/lib/domain/gate";
import type { RepairOption } from "@/lib/domain/types";
import type { TripState } from "@/lib/state";

// Approval records. One is created only when the traveler approves a
// `request_approval` call in the UI; it names the option and the price shown
// to them. Tools that book or charge take its id, never an amount.

export function findOption(state: TripState, optionId: string): RepairOption | undefined {
  return state.options?.find((o) => o.id === optionId);
}

/** Record the traveler's approval of an option at its current price. */
export function createApproval(state: TripState, option: RepairOption, includesRefund = false): Approval | undefined {
  const amountCents = priceCents(option);
  if (amountCents === undefined) return undefined;
  const approval: Approval = {
    id: `ap-${randomUUID()}`,
    optionId: option.id,
    amountCents,
    nonce: randomUUID(),
    used: false,
    includesRefund,
  };
  state.approvals[approval.id] = approval;
  return approval;
}

/**
 * Check an approval against the option it names, as that option stands now,
 * and spend it. Returns the option to act on when the gate opens.
 */
export function consumeApproval(
  state: TripState,
  approvalId: string,
): { gate: GateResult; option?: RepairOption; approval?: Approval } {
  const approval = state.approvals[approvalId];
  const option = approval ? findOption(state, approval.optionId) : undefined;
  const gate = checkGate(option, approval);
  if (gate.allowed) approval!.used = true;
  return { gate, option, approval };
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
