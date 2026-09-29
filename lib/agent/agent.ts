import { isStepCount, type LanguageModel } from "ai";

import type { Session } from "@/lib/state";

import { SYSTEM_PROMPT } from "./prompt";
import { approvalRules, makeTools } from "./tools";

type Env = Record<string, string | undefined>;

/**
 * Enough steps for detect -> options -> present, or approve -> rebook -> settle
 * -> refund request -> follow-ups in one turn.
 */
export const MAX_STEPS = 14;

export class ApprovalSecretError extends Error {}

/**
 * The signing key for approvals. Without it a client could replay a
 * hand-made approval; on Vercel it is required.
 */
export function approvalSecret(env: Env = process.env): string | undefined {
  const secret = env.TOOL_APPROVAL_SECRET;
  if (!secret && (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "production")) {
    throw new ApprovalSecretError("TOOL_APPROVAL_SECRET is required on Vercel");
  }
  return secret;
}

/** Everything streamText / generateText need for one agent turn, minus the messages. */
export function agentSettings(session: Session, model: LanguageModel) {
  return {
    model,
    instructions: SYSTEM_PROMPT,
    tools: makeTools(session),
    toolApproval: approvalRules(session),
    experimental_toolApprovalSecret: approvalSecret(),
    stopWhen: isStepCount(MAX_STEPS),
  };
}
