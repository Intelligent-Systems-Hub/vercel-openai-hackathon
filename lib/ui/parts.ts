import { getToolName, isToolUIPart, type UIMessage } from "ai";

/** A tool call as the UI sees it, flattened out of a message's parts. */
export type ToolView = {
  id: string;
  name: string;
  state: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorText?: string;
  approval?: { id: string; approved?: boolean; isAutomatic?: boolean; requestReason?: string; reason?: string };
};

export function toolView(part: UIMessage["parts"][number]): ToolView | undefined {
  if (!isToolUIPart(part)) return undefined;
  const p = part as unknown as Record<string, unknown>;
  return {
    id: String(p.toolCallId),
    name: getToolName(part),
    state: String(p.state),
    input: (p.input ?? {}) as Record<string, unknown>,
    output: p.output as Record<string, unknown> | undefined,
    errorText: p.errorText as string | undefined,
    approval: p.approval as ToolView["approval"],
  };
}

export function allTools(messages: UIMessage[]): ToolView[] {
  return messages.flatMap((m) => m.parts.map(toolView).filter((t): t is ToolView => Boolean(t)));
}

/** Messages the director posts on the traveler's behalf render as notices, not speech. */
export const NOTICE_PREFIX = "Weather alert:";
