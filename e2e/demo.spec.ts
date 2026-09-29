import { expect, test, type Page } from "@playwright/test";

// The demo as it is shown on stage, end to end in a browser: three scenarios
// (L1–L3), the approval and rebook (S5–S8), and the graph lens (G1–G3).
// Each run uses its own session so runs never share state.

const phone = (page: Page) => page.getByRole("region", { name: "Traveler app" });
const rail = (page: Page) => page.getByRole("region", { name: "Agent activity" });
const alerts = (page: Page) => phone(page).getByRole("region", { name: "Your connection is at risk" });
const graph = (page: Page) => page.getByRole("region", { name: "Traveler context graph" });

test("booking only, then context, the traveler overrides and says why, then the next trip uses it", async ({ page }) => {
  await page.goto(`/?session=e2e-${Date.now()}`);
  const trip = phone(page).getByRole("region", { name: "Your trip" });
  await expect(trip).toContainText("QKRVTB");
  await expect(trip).toContainText("WS 1611");
  await expect(trip).toContainText("Bow River Lodge");
  const lens = page.getByTestId("lens-recommendation");

  // Scenario 1 (G3): booking only. The storm breaks the connection; the same-day connection leads
  await graph(page).getByRole("button", { name: "Booking only" }).click();
  await page.getByRole("button", { name: "Fire the storm at ORD" }).click();
  await expect(alerts(page)).toHaveCount(1);
  await expect(alerts(page)).toContainText("drops to 7 minutes");
  await expect(alerts(page).getByRole("article")).toHaveCount(1);
  await expect(alerts(page).getByRole("article").first()).toHaveAttribute("data-testid", "option-later-connection");
  await expect(rail(page)).toContainText("7 of 97 minutes left to connect");
  await expect(lens).toHaveText("Later ORD connection, same day");
  await expect(page.getByTestId("inspector")).toContainText("No traveler context was used.");

  // Scenario 2 (L1, G1, G2): traveler context on. Nora is on the graph, but that alone doesn't cost a day
  await graph(page).getByRole("button", { name: "Traveler context on" }).click();
  await expect(lens).toHaveText("Later ORD connection, same day");
  // With context it still recommends the later flight, and now shows the overnight as an alternative
  await expect(alerts(page).getByRole("article")).toHaveCount(2);
  await expect(alerts(page).getByRole("article").first()).toHaveAttribute("data-testid", "option-later-connection");
  await expect(graph(page).locator('[data-node="traveler:nora"]')).toBeVisible();
  await expect(page.getByTestId("unused")).toContainText("Gold member");
  // Item 6: the overnight shows what it does for Nora, without being recommended
  await expect(alerts(page).getByTestId("option-overnight-at-hub")).toContainText("crib at no charge");
  await expect(alerts(page).getByTestId("option-overnight-at-hub")).toContainText("bassinet row");

  // L2: the traveler picks the overnight instead; the agent asks why and learns it
  const overnight = alerts(page).getByTestId("option-overnight-at-hub");
  await expect(overnight).toContainText("$401.79");
  await overnight.getByRole("button", { name: "Choose this" }).click();
  const why = phone(page).getByRole("region", { name: "Why this one?" });
  await why.getByRole("button", { name: "Nora needs a real night's sleep" }).click();
  await expect(rail(page)).toContainText("Learned from the traveler's choice");
  await expect(graph(page).locator('[data-node^="learned:"]')).toBeVisible();
  await expect(page.getByTestId("memory")).toContainText("Learned from a choice: “Nora needs a real night's sleep”");
  // The learner is off: written to the graph, not used yet
  await expect(page.getByTestId("unused")).toContainText("the learner is off");

  // S5: approval at the server's price; nothing is booked yet
  const sheet = phone(page).getByRole("region", { name: "Approve this change" });
  await expect(sheet.getByTestId("approval-amount")).toHaveText("$401.79");
  await expect(rail(page)).toContainText("waiting for the traveler");
  await expect(trip).toContainText("QKRVTB");

  // S6, S7: rebooked in never-strand order, charged once
  await sheet.getByRole("button", { name: "Approve $401.79" }).click();
  await expect(phone(page).getByRole("region", { name: "Booking update" })).toContainText("QKRVTA");
  const steps = page.getByTestId("rebook-steps").locator("code");
  await expect(steps).toHaveText([
    "getBooking",
    "checkFlightTickets",
    "createBooking",
    "fulfillFlightTickets",
    "cancelBooking",
    "getBooking",
  ]);
  await expect(phone(page).getByRole("region", { name: "Payment" })).toHaveCount(1);
  await expect(page.getByTestId("ledger-amount")).toHaveText("$401.79");
  await expect(trip).toContainText("QKRVTA");
  await expect(trip).toContainText("UA 764");

  // Item 4: the lodge's policy is clear; the refund request waits for its own yes
  await expect(page.getByTestId("policy-clarity")).toHaveText("Clear: email it");
  const refundSheet = phone(page).getByRole("region", { name: "Confirm refund request" });
  await expect(refundSheet).toContainText("Bow River Lodge, by email");
  await refundSheet.getByRole("button", { name: "Yes, request $520.00" }).click();
  // R1: requested, never promised
  await expect(page.getByTestId("refund-request")).toHaveText(
    "$520.00 requested for the missed night at Bow River Lodge, which would more than cover tonight's $401.79 room if the hotel approves.",
  );
  // Item 5: the refund decision is written back to the graph, with its reason
  await expect(page.getByTestId("memory")).toContainText("Asked Bow River Lodge for $520.00 back, because “Nora needs a real night's sleep”");
  await expect(graph(page).locator('[data-node^="decision:"]')).toBeVisible();
  // R3, S8: the receipt lists what was done, and nothing else; flights offered for the calendar
  const receipt = phone(page).getByRole("region", { name: "Actions taken" });
  await expect(receipt.getByTestId("actions-taken").locator("li")).toHaveCount(3);
  await expect(receipt).toContainText("with your approval; booking QKRVTA");
  await expect(receipt).toContainText("Charged $401.79");
  await expect(receipt).toContainText("Bow River Lodge");
  const calendar = page.getByTestId("calendar-link");
  await expect(calendar).toContainText("Add 4 flights");
  const ics = await page.request.get((await calendar.getAttribute("href"))!);
  expect(ics.headers()["content-type"]).toContain("text/calendar");
  expect(await ics.text()).toContain("SUMMARY:UA 764 ORD → YYC");

  // Scenario 3: same booking, same storm, learner on. The overnight leads, citing last time; the agent proposes
  // the rebook and the refund request together, unprompted, and the human gate still holds
  await page.getByRole("button", { name: "Reset trip (keep memory)" }).click();
  await expect(trip).toContainText("QKRVTB");
  await page.getByRole("group", { name: "Learner" }).getByRole("button", { name: "On" }).click();
  await page.getByRole("button", { name: "Fire the storm at ORD" }).click();
  await expect(alerts(page)).toHaveCount(1);
  const top = alerts(page).getByRole("article").first();
  await expect(top).toHaveAttribute("data-testid", "option-overnight-at-hub");
  await expect(top).toContainText("Last time you chose a night's stop for Nora");
  await expect(top).toContainText("you asked the hotel for the missed night back");
  const proposal = phone(page).getByRole("region", { name: "Approve this change" });
  await expect(proposal.getByTestId("approval-amount")).toHaveText("$401.79");
  await expect(proposal.getByTestId("approval-also")).toHaveText(
    "Also request $520.00 back from Bow River Lodge for the missed night, by email, if the hotel approves",
  );
  await expect(trip).toContainText("QKRVTB");
  await proposal.getByRole("button", { name: "Approve $401.79" }).click();
  // One yes: rebooked, charged, the refund requested without asking again
  await expect(page.getByTestId("refund-request").last()).toContainText("$520.00 requested");
  await expect(phone(page).getByRole("region", { name: "Confirm refund request" })).toHaveCount(0);
  await expect(rail(page)).toContainText("Sent the trip summary");
  await expect(trip).toContainText("QKRVTA");
  await expect(lens).toHaveText("Overnight at ORD, first flight out tomorrow");
  await expect(page.getByTestId("inspector")).toContainText("Storm at ORD → WS 1611 ORD→YYC → Booking QKRVTB → Banff trip → Party of 3 → Nora (infant)");
});
