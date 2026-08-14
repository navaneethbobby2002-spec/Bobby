import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = "src/i18n/messages";
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
let invalid = 0;

for (const file of files) {
  const full = path.join(dir, file);
  try {
    JSON.parse(readFileSync(full, "utf8"));
  } catch (e) {
    invalid += 1;
    console.log(`INVALID: ${file}: ${e.message}`);
  }
}

console.log(`${files.length - invalid}/${files.length} valid`);
