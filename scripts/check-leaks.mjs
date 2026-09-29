// Fails the build if any file in this app carries a marker from the recorded
// supplier data: the brand, account code, booking codes, test-traveler names,
// document and ticket numbers, and the origin host.
//
// The markers are stored only as sha256 hashes of lowercase word tokens, so this
// file can live inside the app without itself containing any of them. The
// plaintext list and the scrub that removes them are in the repo's
// scripts/scrub_fixtures.py, which stays outside the app.
//
// Runs as `prebuild`, so every build (CI, `vercel deploy`, local) is checked.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_HASHES = new Set([
  "ace3e5f024e340557466fe329cfca47b5f534d1cdda1543ba7ca9a4616ea8d50",
  "b33fe1cd72dc82882df1282d233ab1303816f6a1c340ef7cd64cb41f603b7d8e",
  "c0ccc68a06b5b8eacb0b3e4ec36d8146f53520d8d05f26247a6776e642750ec2",
  "d31635c1f9066e95194e5fe9a7d92fc4ae864b8b6bfcde887b7346d4073cb41c",
  "b4b7ff4b1cc6d6fa8222997bdef8337757669931f50d08c3e76b26682109de74",
  "2c2d71524058a1251d93270503c1e869769401160accdf048d1d7e83469cdaa8",
  "2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90",
  "9bba5c53a0545e0c80184b946153c9f58387e3bd1d4ee35740f29ac2e718b019",
  "89d83aff9c513e1ed2bd0158e791198182bc05c4403271fbb90f8dc82d47c9e6",
  "084328c53a9de563b83b23b6f500521ff442af7cfe60f104574c2c8cce22cf2a",
  "c4ad65ffdc11b809668769e97c4e25e42e96bd9fa502122d0b1a83fcac07d070",
  "576c18470150a6989bc15b390561c77fce8a57a18907bf303fbdca89e7bdaad3",
  "f96d956ee68264b654449de277e19964cb83f53091baed373367b1e7e3ec3928",
  "c40ca8935def70b7576e9ac116e7aa417b1e19916ca155803075619f70a98478",
  "06e68c78e480b7555f37a53591516acac9fc25d6a01b43449e4ecd9e9e437ce2",
  "ebccedaba37f0f5fb2f679dde0f848bdea9ae9358abf82457df894842e7ca6a8",
  "12954fbd47ba72ff60edd4f5f3131100c789c609dc93901202c2824be1dc947a",
  "d23fcd7f3c36773dd6b9af8aed5b93414bd951c7078c42f10f89ecf153fe61e5",
  "3121ab46c3dfbb51862711e551bc5d4fa434c1809feb9039b3168fea17166fe4",
]);

const SKIP_DIRS = new Set(["node_modules", ".next", ".vercel", "coverage", ".git"]);
const TOKEN = /[a-z0-9]+/g;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* files(path);
    } else {
      yield path;
    }
  }
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Every (file, line) whose word tokens include a forbidden marker. */
export function findLeaks(root, hashes = FORBIDDEN_HASHES) {
  const leaks = [];
  for (const path of files(root)) {
    const lines = readFileSync(path, "utf8").toLowerCase().split("\n");
    lines.forEach((line, i) => {
      for (const token of line.match(TOKEN) ?? []) {
        if (hashes.has(sha256(token))) {
          leaks.push({ file: relative(root, path), line: i + 1, hash: sha256(token).slice(0, 12) });
          break;
        }
      }
    });
  }
  return leaks;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const leaks = findLeaks(root);
  if (leaks.length) {
    console.error(`check-leaks: ${leaks.length} forbidden marker(s) found`);
    for (const l of leaks.slice(0, 50)) console.error(`  ${l.file}:${l.line} (token hash ${l.hash})`);
    process.exit(1);
  }
  console.log("check-leaks: OK");
}
