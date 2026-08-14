import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");

test("electron build copies the standalone runtime into resources/app exactly once", () => {
  const electronPackage = JSON.parse(readFileSync(join(ROOT, "electron", "package.json"), "utf8"));

  const extraResources = electronPackage.build?.extraResources;
  assert.ok(Array.isArray(extraResources), "electron build.extraResources must be an array");

  const appResources = extraResources.filter(
    (resource) => resource?.to === "app" || resource?.to?.startsWith("app/")
  );

  assert.deepEqual(appResources, [
    {
      from: "../.build/electron-standalone",
      to: "app",
      filter: ["**/*"],
    },
  ]);
});

test("electron standalone assembly normalizes Turbopack hashed external imports", () => {
  const prepareScript = readFileSync(
    join(ROOT, "scripts", "build", "prepare-electron-standalone.mjs"),
    "utf8"
  );

  assert.match(
    prepareScript,
    /assembleStandalone\(\{[\s\S]*?patchTurbopackChunks:\s*true,[\s\S]*?\}\);/,
    "Electron packages must strip Turbopack's hashed external package names before bundling"
  );
});
