import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";

import { agentSettings } from "@/lib/agent/agent";
import { resolveModel } from "@/lib/agent/model";
import { getStore, Session } from "@/lib/state";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages, sessionId }: { messages: UIMessage[]; sessionId?: string } = await req.json();
  const store = getStore();
  const session = new Session(sessionId || "demo", store);
  const { model, mode } = await resolveModel(store);

  const result = streamText({
    ...agentSettings(session, model),
    messages: await convertToModelMessages(messages),
  });

  const response = createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) });
  response.headers.set("x-agent-model", mode);
  return response;
}
