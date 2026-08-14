import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = "src/i18n/messages";
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

const CAP_KEYS = [
  "visionMismatch",
  "toolsMismatch",
  "structuredOutputMismatch",
  "contextWindowMismatch",
];
const DEGRADED_SOURCE_KEYS = ["database", "circuitBreaker", "modelLockouts", "count"];

function fixTopLevelCapabilityFilter(root) {
  const prefix = "capabilityFilter.";
  const entries = Object.entries(root);
  const hasDotted = entries.some(([k]) => k.startsWith(prefix));
  if (!hasDotted) return root;

  const out = {};
  let inserted = false;
  for (const [key, value] of entries) {
    if (key.startsWith(prefix)) {
      if (!inserted) {
        const nested = {};
        for (const sub of CAP_KEYS) {
          const full = prefix + sub;
          if (full in root) nested[sub] = root[full];
        }
        out.capabilityFilter = nested;
        inserted = true;
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

function fixResilienceDegradedSource(root) {
  const rc = root.resilienceConnections;
  if (!rc || typeof rc !== "object") return root;

  const prefix = "degraded.source.";
  const entries = Object.entries(rc);
  const hasDotted = entries.some(([k]) => k.startsWith(prefix));
  if (!hasDotted) return root;

  const out = {};
  let inserted = false;
  for (const [key, value] of entries) {
    if (key.startsWith(prefix)) {
      if (!inserted) {
        const nested = {};
        for (const sub of DEGRADED_SOURCE_KEYS) {
          const full = prefix + sub;
          if (full in rc) nested[sub] = rc[full];
        }
        out.degradedSource = nested;
        inserted = true;
      }
      continue;
    }
    out[key] = value;
  }

  return { ...root, resilienceConnections: out };
}

let changedCount = 0;
for (const file of files) {
  const full = path.join(dir, file);
  const raw = readFileSync(full, "utf8");
  const data = JSON.parse(raw);

  let next = fixTopLevelCapabilityFilter(data);
  next = fixResilienceDegradedSource(next);

  const serialized = JSON.stringify(next, null, 2);
  if (serialized !== JSON.stringify(data, null, 2)) {
    writeFileSync(full, serialized, "utf8");
    changedCount += 1;
  }
}

console.log(`Fixed ${changedCount}/${files.length} locale files.`);
