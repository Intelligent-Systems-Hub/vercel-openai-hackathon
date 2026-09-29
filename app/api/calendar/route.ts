import { tripCalendar } from "@/lib/actions/calendar";
import { getStore, Session } from "@/lib/state";

// The rebooked flights as an .ics download, offered by the add_to_calendar tool.
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId") || "demo";
  const { trip } = await new Session(sessionId, getStore()).state();
  return new Response(tripCalendar(trip), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${trip.bookingCode}.ics"`,
    },
  });
}
