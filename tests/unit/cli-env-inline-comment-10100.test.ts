import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// #10100 — the .env loader kept inline comments inside values, so the shipped
// `QUOTA_STORE_DRIVER=sqlite  # sqlite | redis` line produced the literal value
// "sqlite              # sqlite | redis". Consumers compare with `===`, so a
// user annotating `QUOTA_STORE_DRIVER=redis  # ...` silently got SQLite with no
// warning (the existing warning lives inside the `redis` branch).

const LOADER = path.resolve("bin/omniroute.mjs");

/**
 * The loader is a CLI entrypoint with side effects on import, so exercise the
 * pure helper by extracting it from source rather than importing the module.
 */
function loadParseEnvValue(): (raw: string) => string {
  const source = fs.readFileSync(LOADER, "utf8");
  const start = source.indexOf("function parseEnvValue(");
  assert.ok(start > -1, "parseEnvValue should exist in bin/omniroute.mjs");
  // Walk to the end of the function body.
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return new Function(`${source.slice(start, end)}; return parseEnvValue;`)() as (
    raw: string
  ) => string;
}

const parseEnvValue = loadParseEnvValue();

test("an unquoted inline comment is stripped", () => {
  assert.equal(parseEnvValue("sqlite              # sqlite | redis"), "sqlite");
  assert.equal(parseEnvValue("redis   # sqlite | redis"), "redis");
  assert.equal(parseEnvValue("value\t# tab-separated comment"), "value");
});

test("a '#' with no preceding whitespace is part of the value", () => {
  // dotenv semantics — passwords and fragments must survive.
  assert.equal(parseEnvValue("pass#word"), "pass#word");
  assert.equal(
    parseEnvValue("https://example.com/page#section"),
    "https://example.com/page#section"
  );
});

test("quoted values are returned verbatim, including '#'", () => {
  assert.equal(parseEnvValue('"sqlite # not a comment"'), "sqlite # not a comment");
  assert.equal(parseEnvValue("'a # b'"), "a # b");
  // A comment may still follow a closing quote.
  assert.equal(parseEnvValue('"sqlite"   # sqlite | redis'), "sqlite");
});

test("plain values are unchanged", () => {
  assert.equal(parseEnvValue("sqlite"), "sqlite");
  assert.equal(parseEnvValue("  spaced  "), "spaced");
  assert.equal(parseEnvValue(""), "");
});

test(".env.example no longer annotates QUOTA_STORE_DRIVER inline", () => {
  const example = fs.readFileSync(path.resolve(".env.example"), "utf8");
  const line = example.split("\n").find((l) => l.startsWith("QUOTA_STORE_DRIVER="));
  assert.ok(line, "QUOTA_STORE_DRIVER should still be documented");
  assert.equal(line, "QUOTA_STORE_DRIVER=sqlite");
  // Guard the whole file against reintroducing the pattern on unquoted values.
  const offenders = example
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=[^"'#\n]*\s#/.test(l))
    .slice(0, 5);
  assert.deepEqual(offenders, [], `unquoted inline comments would land in the value: ${offenders}`);
});
