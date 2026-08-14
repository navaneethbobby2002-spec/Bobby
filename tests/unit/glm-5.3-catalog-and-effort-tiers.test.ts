import test from "node:test";
import assert from "node:assert/strict";

// GLM-5.3 support (released 2026-08-14, https://z.ai/blog/glm-5.3).
//
// Upstream ships ONE model id (`glm-5.3`) — effort is a request parameter
// (`reasoning_effort`: low|high|max, default max) on the coding chat/completions
// endpoint, and `thinking.type: "disabled"` is rejected (converted to low by the
// coding endpoint). OmniRoute keeps the GLM-5.2 tier UX: `glm-5.3-high` /
// `glm-5.3-low` pseudo-ids resolved by the GlmExecutor only. Base `glm-5.3` uses
// the upstream default (max). Unlike the 5.2 tiers (Anthropic-transport effort
// beta header), the 5.3 tiers use the documented `reasoning_effort` param on the
// OpenAI coding transport.
//
// Spec caveat: Z.ai has not yet published the default context window — 1M is
// mirrored from GLM-5.2 (same base model) per operator decision; correct when
// the official spec lands.

const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
const { GlmExecutor } = await import("../../open-sse/executors/glm.ts");
const { MODEL_SPECS } = await import("../../src/shared/constants/modelSpecs.ts");
const { GLM_PRICING } = await import("../../src/shared/constants/pricing/shared-tiers.ts");

const GLM_5_3_IDS = ["glm-5.3", "glm-5.3-high", "glm-5.3-low"] as const;

// transformForTransport returns an opaque body; surface only the fields asserted below.
type TransformedRequest = {
  model?: string;
  reasoning_effort?: string;
  thinking?: { type?: string } | null;
  max_tokens?: number;
  effort?: string;
};

function modelIds(provider: string): string[] {
  const entry = getRegistryEntry(provider);
  assert.ok(entry, `provider "${provider}" should be registered`);
  return (entry.models ?? []).map((m) => m.id);
}

for (const provider of ["glm", "glm-cn", "glmt"]) {
  test(`${provider} advertises the GLM-5.3 base model and effort tiers (GLM_SHARED_MODELS)`, () => {
    const ids = modelIds(provider);
    for (const id of GLM_5_3_IDS) {
      assert.ok(ids.includes(id), `${provider} should expose ${id}; got ${ids.join(", ")}`);
    }
  });

  test(`${provider} GLM-5.3 entries mirror the GLM-5.2 shape (1M ctx, 128K out)`, () => {
    const models = getRegistryEntry(provider)!.models ?? [];
    const base = models.find((m) => m.id === "glm-5.3");
    assert.ok(base, "glm-5.3 entry missing");
    assert.equal(base.contextLength, 1_000_000);
    assert.equal(base.maxOutputTokens, 131_072);
    assert.equal(base.toolCalling, true);
    assert.equal(base.supportsReasoning, true);
  });
}

test("zai advertises the GLM-5.3 base model only (DefaultExecutor sends ids verbatim)", () => {
  const ids = modelIds("zai");
  assert.ok(ids.includes("glm-5.3"), `zai should advertise glm-5.3; got ${ids.join(", ")}`);
  for (const alias of ["glm-5.3-high", "glm-5.3-low"]) {
    assert.ok(
      !ids.includes(alias),
      `zai must not list ${alias}: GlmExecutor-only alias, unknown upstream on the Anthropic endpoint`
    );
  }
});

test("modelSpecs carries 1M/128K specs for all GLM-5.3 ids", () => {
  for (const id of GLM_5_3_IDS) {
    const spec = MODEL_SPECS[id];
    assert.ok(spec, `MODEL_SPECS should include ${id}`);
    assert.equal(spec.contextWindow, 1_000_000);
    assert.equal(spec.maxOutputTokens, 131_072);
    assert.equal(spec.supportsThinking, true);
  }
});

test("GLM_PRICING covers the GLM-5.3 ids with GLM-5.2-parity rates", () => {
  const reference = GLM_PRICING["glm-5.2"];
  assert.ok(reference, "glm-5.2 pricing reference missing");
  for (const id of GLM_5_3_IDS) {
    const pricing = GLM_PRICING[id];
    assert.ok(pricing, `GLM_PRICING should include ${id}`);
    assert.deepEqual(pricing, reference);
  }
});

test("GlmExecutor resolves glm-5.3-high to reasoning_effort=high on the OpenAI coding transport", () => {
  const executor = new GlmExecutor("glm");
  const transformed = executor.transformForTransport(
    "glm-5.3-high",
    { messages: [{ role: "user", content: "hi" }] },
    false,
    { apiKey: "glm-key" },
    "openai"
  ) as TransformedRequest;

  assert.equal(transformed.model, "glm-5.3", "upstream must receive the base model id");
  assert.equal(transformed.reasoning_effort, "high");
  assert.equal(transformed.thinking?.type, "enabled");
});

test("GlmExecutor resolves glm-5.3-low to reasoning_effort=low with thinking enabled", () => {
  const executor = new GlmExecutor("glm");
  const transformed = executor.transformForTransport(
    "glm-5.3-low",
    { messages: [{ role: "user", content: "hi" }] },
    false,
    { apiKey: "glm-key" },
    "openai"
  ) as TransformedRequest;

  assert.equal(transformed.model, "glm-5.3");
  assert.equal(transformed.reasoning_effort, "low");
  assert.equal(transformed.thinking?.type, "enabled");
});

test("GlmExecutor leaves base glm-5.3 without an injected reasoning_effort (upstream default = max)", () => {
  const executor = new GlmExecutor("glm");
  const transformed = executor.transformForTransport(
    "glm-5.3",
    { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] },
    false,
    { apiKey: "glm-key" },
    "openai"
  ) as TransformedRequest;

  assert.equal(transformed.model, "glm-5.3");
  assert.equal(transformed.reasoning_effort, undefined);
  // Thinking-model max_tokens default applies to 5.3 (GLM_THINKING_MODEL_PATTERN)
  assert.equal(transformed.max_tokens, 131_072);
});

test("GLM-5.3 effort tiers execute on the OpenAI coding transport (no Anthropic-only pinning)", async () => {
  const executor = new GlmExecutor("glm");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(
      'data: {"id":"chatcmpl-glm53","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } }
    );
  };

  try {
    await executor.execute({
      model: "glm-5.3-high",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: true,
      credentials: {
        apiKey: "glm-key",
        providerSpecificData: { baseUrl: "https://api.z.ai/api/coding/paas/v4" },
      },
    });

    assert.deepEqual(calls, ["https://api.z.ai/api/coding/paas/v4/chat/completions"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GLM-5.2 effort tiers still pin the Anthropic transport (effort beta header) — regression guard", () => {
  const executor = new GlmExecutor("glm");
  const transformed = executor.transformForTransport(
    "glm-5.2-max",
    { messages: [{ role: "user", content: "hi" }] },
    false,
    { apiKey: "glm-key" },
    "anthropic"
  ) as TransformedRequest;

  assert.equal(transformed.model, "glm-5.2");
  assert.equal(transformed.effort, "max");
  assert.equal(transformed.thinking?.type, "enabled");
});
