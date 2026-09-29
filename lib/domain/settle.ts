import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURE_ROOT } from "@/lib/fixtures";

import type { Approval } from "./gate";

// Settling the difference. Money is only ever the PayPal sandbox or the
// recorded sandbox responses; a production endpoint is refused outright.

export type LedgerEntry = {
  approvalId: string;
  kind: "charge" | "refund" | "none";
  amountCents: number;
  orderId?: string;
  captureId?: string;
  refundId?: string;
};

export class NotSandboxError extends Error {}

/** Refuse to run against anything but the PayPal sandbox. */
export function assertSandbox(baseUrl = process.env.PAYPAL_BASE_URL): void {
  if (baseUrl && !/^https:\/\/api(-m)?\.sandbox\.paypal\.com\/?$/.test(baseUrl)) {
    throw new NotSandboxError(`refusing a non-sandbox PayPal endpoint: ${baseUrl}`);
  }
}

function recorded(dir: string): Record<string, unknown>[] {
  const root = join(FIXTURE_ROOT, dir);
  return readdirSync(root)
    .sort()
    .map((f) => JSON.parse(JSON.parse(readFileSync(join(root, f), "utf8")).body));
}

/**
 * Charge or refund the approved amount, once. A second call for the same
 * approval returns the first entry instead of moving money again.
 */
export function settle(approval: Approval, ledger: LedgerEntry[]): { entry: LedgerEntry; repeated: boolean } {
  assertSandbox();
  const existing = ledger.find((e) => e.approvalId === approval.id);
  if (existing) return { entry: existing, repeated: true };

  const cents = approval.amountCents;
  if (cents === 0) return { entry: { approvalId: approval.id, kind: "none", amountCents: 0 }, repeated: false };

  if (cents > 0) {
    const order = recorded("create_order")[0];
    const capture = recorded("capture").find((c) => c.id === order.id)!;
    const unit = (capture.purchase_units as Record<string, unknown>[])[0];
    const captured = ((unit.payments as Record<string, unknown>).captures as Record<string, unknown>[])[0];
    return {
      entry: {
        approvalId: approval.id,
        kind: "charge",
        amountCents: cents,
        orderId: String(order.id),
        captureId: String(captured.id),
      },
      repeated: false,
    };
  }

  const refund = recorded("refund")[0];
  return {
    entry: { approvalId: approval.id, kind: "refund", amountCents: cents, refundId: String(refund.id) },
    repeated: false,
  };
}
