import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = "src/i18n/messages";
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

const patterns = new Map();

for (const file of files) {
  const full = path.join(dir, file);
  const data = JSON.parse(readFileSync(full, "utf8"));

  function walk(obj, prefix) {
    if (obj === null || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      if (key.includes(".")) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (!patterns.has(full)) patterns.set(full, new Set());
        patterns.get(full).add(file);
      }
      const val = obj[key];
      if (val !== null && typeof val === "object") {
        walk(val, prefix ? `${prefix}.${key}` : key);
      }
    }
  }
  walk(data, "");
}

console.log(`Files scanned: ${files.length}`);
console.log(`Distinct dotted-key paths found: ${patterns.size}\n`);
for (const [key, fileSet] of [...patterns.entries()].sort()) {
  console.log(`${key}  (in ${fileSet.size} files)`);
}
