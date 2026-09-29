import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { findLeaks } from "./check-leaks.mjs";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Built at runtime so this file never contains the marker as one token.
const MARKER = ["sa", "bre"].join("");

describe("check-leaks", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("flags a planted marker, whatever its case, with file and line", () => {
    dir = mkdtempSync(join(tmpdir(), "leaks-"));
    writeFileSync(join(dir, "clean.json"), '{"provider": "replay"}\n');
    writeFileSync(join(dir, "dirty.json"), `{\n  "host": "mcp.cert.${MARKER.toUpperCase()}.com"\n}\n`);
    expect(findLeaks(dir)).toEqual([expect.objectContaining({ file: "dirty.json", line: 2 })]);
  });

  it("skips dependency and build folders", () => {
    dir = mkdtempSync(join(tmpdir(), "leaks-"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), MARKER);
    expect(findLeaks(dir)).toEqual([]);
  });

  it("finds nothing in this app, fixtures included", () => {
    dir = mkdtempSync(join(tmpdir(), "leaks-")); // unused; keeps afterEach simple
    expect(findLeaks(APP_ROOT)).toEqual([]);
  });
});
