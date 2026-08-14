import test from "node:test";
import assert from "node:assert/strict";

// Regression test for the providers-route PATCH gap: the OpenAPI spec and the
// CLI (`omniroute providers rotate`, generated api-commands) both use
// PATCH /api/providers/[id], but the route only implemented PUT — PATCH
// requests 405'd and `providers rotate --new-key` silently failed while
// reporting success. See PR fix: the route now exports a PATCH handler that
// delegates to PUT (both apply the same partial-update schema).

async function loadRoute() {
  return await import(new URL("../../src/app/api/providers/[id]/route.ts", import.meta.url));
}

test("providers [id] route exports a PATCH handler (CLI rotate 405 regression)", async () => {
  const route = await loadRoute();
  assert.equal(
    typeof route.PATCH,
    "function",
    "PATCH handler must exist — CLI rotate sends PATCH per the OpenAPI spec"
  );
});

test("PATCH handler delegates to PUT (same partial-update semantics)", async () => {
  const route = await loadRoute();
  // The PATCH export delegates to PUT; both share the same update logic. They
  // are distinct function references (wrapper), so assert both exist and that
  // invoking PATCH returns whatever PUT would (mock auth rejects first, so a
  // delegation error surfaces as the PUT auth error, not a 405/undefined).
  const request = new Request("http://localhost/api/providers/test-id", {
    method: "PATCH",
    body: JSON.stringify({ name: "x" }),
  });
  const ctx = { params: Promise.resolve({ id: "test-id" }) };
  const patchResult = await route.PATCH(request, ctx);
  assert.ok(patchResult, "PATCH should return a response, not 405");
  assert.equal(
    patchResult.status,
    401,
    "delegation reaches the shared auth path (PUT's auth error)"
  );
});

test("providers [id] route still exports PUT and DELETE handlers", async () => {
  const route = await loadRoute();
  assert.equal(typeof route.PUT, "function");
  assert.equal(typeof route.DELETE, "function");
});
