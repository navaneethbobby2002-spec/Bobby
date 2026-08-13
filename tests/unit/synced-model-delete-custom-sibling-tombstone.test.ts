/**
 * Deleting a CUSTOM model must not tombstone a same-id SYNCED model.
 *
 * Reported flow (provider `deepseek`, models `deepseek-v4-flash` / `deepseek-v4-pro`):
 *   1. Eye-hide both synced models          -> `isHidden:true`  (no `isDeleted`)
 *   2. Manually ADD custom models with the SAME ids
 *   3. DELETE the custom models just created
 *   4. The ORIGINAL synced models are gone too, yet the UI still lists them
 *
 * Step 3 is the bug. `DELETE /api/provider-models` resolves `provider` + `model`
 * only — it has no notion of WHICH of the two same-id rows the operator clicked.
 * It unconditionally runs both removals and then, because the synced removal
 * reports `true`, writes the `isDeleted:true` tombstone. From then on
 * `replaceSyncedAvailableModelsForConnection` filters the id out of every
 * re-import (`getModelIsDeleted`), so the provider can never resync: the sync
 * endpoint keeps reporting `added: N` while the catalog stays empty, and
 * `/v1/models` never lists the models again.
 *
 * The eye-hide in step 1 is what makes this reachable in practice — a hidden
 * model stays in the synced store (#3782), so the id exists in BOTH stores at
 * the same time and one DELETE hits both.
 *
 * Guards: A = deleting a custom model leaves a same-id synced sibling intact and
 * re-importable; B = deleting a synced-only model still tombstones (#3199 must
 * not regress).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Hermetic DB: this test writes into the `customModels`, `syncedAvailableModels`
// and `modelCompatOverrides` namespaces. Without an isolated DATA_DIR it would
// leak that state into the shared dev/CI database, so a SECOND run would see
// stale tombstones and the preconditions would fail. Point DATA_DIR at a
// throwaway dir before any import that opens the SQLite handle.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-delete-sibling-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// The DELETE route is auth-gated; with no INITIAL_PASSWORD and no stored
// credential, `isAuthenticated` resolves true for local management calls.
delete process.env.INITIAL_PASSWORD;

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const providerModelsRoute = await import("../../src/app/api/provider-models/route.ts");

const PROVIDER = "deepseek";
const CONNECTION = "conn-delete-sibling";
const FLASH = "deepseek-v4-flash";
const PRO = "deepseek-v4-pro";

test.after(() => {
  // Release the SQLite handle so the Node test runner can exit, then remove the
  // throwaway DATA_DIR (CLAUDE.md "Database Handles in Tests").
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

/** Invoke the real DELETE handler so the test tracks production behavior. */
async function deleteProviderModel(provider: string, modelId: string) {
  const url =
    `http://localhost/api/provider-models` +
    `?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(modelId)}`;
  const response = await providerModelsRoute.DELETE(new Request(url, { method: "DELETE" }));
  assert.equal(response.status, 200, "DELETE /api/provider-models should succeed");
  return response.json();
}

test("A: deleting a custom model leaves a same-id synced sibling re-importable", async () => {
  core.resetDbInstance();

  // Step 1 — provider sync brings both models in; operator eye-hides one.
  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, CONNECTION, [
    { id: FLASH, name: FLASH },
    { id: PRO, name: PRO },
  ]);
  modelsDb.mergeModelCompatOverride(PROVIDER, FLASH, { isHidden: true });
  assert.equal(
    modelsDb.getModelIsDeleted(PROVIDER, FLASH),
    false,
    "precondition: eye-hide must not mark the model deleted"
  );

  // Step 2 — operator manually adds a custom model with the SAME id.
  await modelsDb.addCustomModel(PROVIDER, FLASH, FLASH);

  // Step 3 — operator deletes the custom model they just created.
  await deleteProviderModel(PROVIDER, FLASH);

  // Step 4 — the synced sibling must NOT have been tombstoned.
  assert.equal(
    modelsDb.getModelIsDeleted(PROVIDER, FLASH),
    false,
    "deleting the custom model must not write an isDeleted tombstone for the synced sibling"
  );

  // The decisive assertion: a later re-sync must bring the model back.
  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, CONNECTION, [
    { id: FLASH, name: FLASH },
    { id: PRO, name: PRO },
  ]);
  const ids = (await modelsDb.getSyncedAvailableModels(PROVIDER)).map((m: { id: string }) => m.id);
  assert.ok(
    ids.includes(FLASH),
    `re-import must restore the synced model; got [${ids.join(", ")}]`
  );
});

test("B: deleting a synced-only model still tombstones it (#3199 must not regress)", async () => {
  core.resetDbInstance();

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, CONNECTION, [
    { id: PRO, name: PRO },
  ]);
  assert.equal(modelsDb.getModelIsDeleted(PROVIDER, PRO), false, "precondition: not yet deleted");

  // No custom row exists for this id — this is a real trash/delete.
  await deleteProviderModel(PROVIDER, PRO);

  assert.equal(
    modelsDb.getModelIsDeleted(PROVIDER, PRO),
    true,
    "a synced-only delete must still write the isDeleted tombstone"
  );

  await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, CONNECTION, [
    { id: PRO, name: PRO },
  ]);
  const ids = (await modelsDb.getSyncedAvailableModels(PROVIDER)).map((m: { id: string }) => m.id);
  assert.ok(
    !ids.includes(PRO),
    `a deleted model must stay dropped across re-import; got [${ids.join(", ")}]`
  );
});
