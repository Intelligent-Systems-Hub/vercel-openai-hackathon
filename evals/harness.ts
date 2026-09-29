import { generateText, type LanguageModel, type ModelMessage } from "ai";

import { agentSettings } from "@/lib/agent/agent";
import { MemoryStore, Session } from "@/lib/state";

// Drives the agent the way the phone does: user turns, and approval answers
// when the agent asks. Records every tool call so evals can check the order of
// what the agent DID, not the words it chose.

export type Turn = { toolCalls: { name: string; input: unknown }[]; approvalIds: string[]; text: string };

export class Conversation {
  readonly session: Session;
  private messages: ModelMessage[] = [];
  readonly log: { name: string; input: unknown }[] = [];

  constructor(
    private model: LanguageModel,
    id: string,
    private depart = "2026-09-29",
  ) {
    this.session = new Session(id, new MemoryStore(), depart);
  }

  private async turn(message: ModelMessage): Promise<Turn> {
    this.messages.push(message);
    const result = await generateText({ ...agentSettings(this.session, this.model), messages: this.messages });
    this.messages.push(...result.responseMessages);
    const toolCalls = result.steps.flatMap((s) =>
      s.toolCalls.map((c) => ({ name: c.toolName as string, input: c.input as unknown })),
    );
    this.log.push(...toolCalls);
    const approvalIds = result.content
      // Only approvals that wait for the traveler; automatic ones (already covered by a yes) run by themselves.
      .filter((p) => p.type === "tool-approval-request" && !(p as { isAutomatic?: boolean }).isAutomatic)
      .map((p) => (p as { approvalId: string }).approvalId);
    return { toolCalls, approvalIds, text: result.text };
  }

  say(text: string) {
    return this.turn({ role: "user", content: text });
  }

  answer(approvalId: string, approved: boolean) {
    return this.turn({ role: "tool", content: [{ type: "tool-approval-response", approvalId, approved }] });
  }

  storm() {
    return this.session.update((s) => void (s.storm = true));
  }

  resetTrip() {
    return this.session.resetTrip();
  }

  state() {
    return this.session.state();
  }

  memory() {
    return this.session.memory();
  }

  /** Did `later` happen, and only after `earlier`? */
  calledAfter(earlier: string, later: string): boolean {
    const names = this.log.map((c) => c.name);
    const i = names.indexOf(earlier);
    const j = names.indexOf(later);
    return i >= 0 && j > i;
  }
}
