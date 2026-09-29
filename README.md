# Traveler Care with Intelligence: the Trip Repair Agent

An agent that looks after a family's trip once it's booked. When a storm breaks their connection, it finds options that fit the family, asks before it acts, rebooks, pays for the room, requests the missed hotel night back, and learns from what the family chose for next time.

Built by the Intelligent Systems team for the AI Collective × Madrona × Vercel × OpenAI hackathon (Seattle, 29 Sep 2026).

**Live:** https://trip-repair-agent.vercel.app

## The demo

The booked trip: Maya, Sam and their lap infant Nora, New York (JFK) to Calgary (YYC) through Chicago O'Hare, with five nights at Bow River Lodge in Banff. The family, the lodge and its refund policy are fictional.

1. **Fire the storm at ORD** (the Director panel). Their 97-minute connection drops to 7 minutes, and the agent picks it up on its own.
2. **It reads the traveler context graph.** It walks from the storm to the flight, the booking, the trip, the party, and Nora. With traveler context on, the overnight at O'Hare shows a crib and a bassinet row, but the same-day flight still leads: a baby alone isn't reason enough to cost a family a day.
3. **The family picks the overnight anyway**, and the agent asks why. The reason ("Nora needs a real night's sleep") is written to the graph.
4. **Approve.** It rebooks, issuing the new tickets before releasing the old ones, then settles the room (PayPal sandbox) and checks the lodge's policy. With a second yes, it emails a refund request for the missed night. A refund is only ever *requested*, "if the hotel approves".
5. **Reset trip (keep memory), turn the Learner on, fire the storm again.** The overnight now leads, citing what the family said last time, and the rebooking and the refund request arrive together on one approval sheet.

## How it's built

| | |
|---|---|
| **Next.js 16** (App Router) on **Vercel** | The traveler's app, the context-graph view, the activity log, and the API routes (`app/api/chat`, `app/api/director`, …) |
| **Vercel AI SDK** | The agent loop, typed tools (zod schemas), and tool approval: `request_approval`, `email_hotel` and `call_hotel` wait for the traveler, and approvals are signed with `TOOL_APPROVAL_SECRET` |
| **OpenAI GPT-5.5** (`@ai-sdk/openai`) | All the reasoning, and every tool call. Without a key, a scripted model runs the same flow |
| **Upstash Redis** (Vercel Marketplace) | Session state on Vercel; locally, an in-memory store |
| **Resend**, **Twilio** | Follow-ups, sent only to allowlisted addresses and only with `LIVE_ACTIONS=on`. The optional hotel phone call (Twilio to OpenAI Realtime SIP) is simulated unless `LIVE_CALLS=on` |

Where things are: `lib/agent` (prompt, tools, approval rules), `lib/domain` (detect, options, rank, gate, execute, settle, policy), `lib/graph` (the traveler context graph and its walk), `lib/replay` (fixture replay), `components` (the phone app, graph, activity rail), `evals`.

## Guardrails

- Nothing is booked or charged until the traveler approves. The approval shows the price the server holds, and the tools that book or charge take an approval id, never an amount.
- Approvals are signed, and the server never books on an approval it didn't issue (see "forged approvals" in `lib/agent/agent.test.ts`).
- The options, their order and their prices come from the tools and the server's state, not from the model's text, and the prompt forbids inventing a flight, price or hotel.
- With `LIVE_ACTIONS` unset, emails and texts are composed and logged, not sent.

## Replay fixtures

`fixtures/` holds recorded, scrubbed servicing responses (flight shopping, hotel rates, trip orders, and a payment sandbox) that the app replays, so it needs no supplier account. `npm run check-leaks` runs before every build and fails if any scrubbed marker reappears.

## Run it

Needs Node 22 or newer.

```bash
npm ci
cp .env.example .env.local   # optional: set OPENAI_API_KEY and OPENAI_MODEL=gpt-5.5 to run on OpenAI
npm run dev                  # http://localhost:3000
```

To deploy on Vercel, set `TOOL_APPROVAL_SECRET` and connect Upstash Redis from the Marketplace (a preview or production deploy refuses to start without them), then `vercel deploy`. Every variable is described in `.env.example`.

## Tests and evals

```bash
npm test                               # 234 unit tests
npx next typegen && npm run typecheck  # route types are generated, not committed
npm run build && npx playwright test   # the whole demo in a browser, on the scripted model
OPENAI_MODEL=gpt-5.5 npm run eval      # 26 behaviour checks against the real model, each run 5 times
```

The last eval (`evals/results/openai-latest.json`, gpt-5.5, 28 Sep 2026) passed all 26 checks in 5 of 5 runs.
