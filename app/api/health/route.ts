import { loadRole } from "@/lib/fixtures";

// Proves the fixtures shipped with the deployment: reads the booked-trip
// recording from disk and reports what it found. Check it on every preview.
export async function GET() {
  try {
    const pair = loadRole("seedOffer");
    return Response.json({
      ok: true,
      path: pair.meta.fullPath,
      digest: pair.meta.requestDigest,
      status: pair.response.status,
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
