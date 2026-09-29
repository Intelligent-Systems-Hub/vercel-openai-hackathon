import { createHash } from "node:crypto";

// Fixture files are named by sha256 over the request's canonical JSON, as the
// capture harness wrote it with Python's
//   json.dumps(payload, sort_keys=True, separators=(",", ":"))
// This reproduces that byte for byte: sorted keys, no spaces, and non-ASCII
// escaped as \uXXXX (Python's ensure_ascii default). The recorded requests hold
// no floats, so number formatting never differs between the two.

function encodeString(s: string): string {
  return JSON.stringify(s).replace(
    /[\u0080-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? encodeString(value) : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${encodeString(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function requestDigest(request: unknown): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}
