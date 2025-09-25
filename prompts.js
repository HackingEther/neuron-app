// prompts.js
// Builds the chat messages for the LLM. "Rules-free": we DO NOT require a rules file.
// We give the model small, precise context and demand a strict JSON plan output.

export function buildMessages(input, jsonSchema) {
  const { repo_meta, signals, changed_files, existing_tests, requirements } = input;

  const system = [
    "You are Neuron, a senior software reviewer.",
    "Goal: infer product intent and business logic directly from repository signals and the PR diff.",
    "Then produce:",
    "  (1) Up to 3 high-impact REVIEW COMMENTS tied to specific changed lines, framed in business terms (who breaks, why).",
    "  (2) Up to 2 RUNNABLE TESTS in the detected framework that validate the risky behavior or guard against regression.",
    "Constraints:",
    "- Return ONLY valid JSON that matches the provided schema.",
    "- Prefer precision over breadth—do NOT exceed the caps.",
    "- If you cannot produce a runnable test with the detected framework, return an empty 'tests' array.",
    "- For each comment, cite exact reasoning based on DIFF HUNKS and repository signals; avoid generic claims.",
    "- Avoid repeats: do not suggest the same fix multiple ways; merge them into one best suggestion.",
    "- Optimization is allowed (e.g., slow payment window, blocking IO, missing timeout/circuit breaker/idempotency).",
    "- When suggesting code, target the actual stack and imports present in the changed files; do not invent foreign APIs."
  ].join("\n");

  // A tiny few-shot to anchor tone/shape (keeps it compact)
  const example = {
    comments: [
      {
        path: "src/payments/authorize.ts",
        line: 87,
        severity: "HIGH",
        title: "Payment authorize path may stall under load",
        body:
          "Checkout users can hang when the gateway is slow: three sequential network calls without timeouts.\n" +
          "Suggested remediation: set per-call 2s timeout, execute customer lookup + tokenization in parallel, and use gateway idempotency keys.\n" +
          "Business impact: higher cart abandonment during spikes."
      }
    ],
    tests: [
      {
        language: "javascript",
        framework: "jest",
        path: "__tests__/neuron.generated.test.js",
        mode: "append_or_create",
        content:
          "// neuron generated\n" +
          "import { authorizePayment } from '../src/payments/authorize';\n" +
          "test('authorize times out fast on a slow gateway', async () => {\n" +
          "  jest.useFakeTimers();\n" +
          "  const slowGateway = { charge: jest.fn(() => new Promise(() => {})) };\n" +
          "  const start = Date.now();\n" +
          "  await expect(authorizePayment(slowGateway, { amount: 100 })).rejects.toThrow();\n" +
          "  const elapsed = Date.now() - start;\n" +
          "  expect(elapsed).toBeLessThan(2500);\n" +
          "});\n"
      }
    ]
  };

  const repoSketch = [
    `repo: ${repo_meta.owner}/${repo_meta.repo} @ ${repo_meta.headRef}`,
    `languages: ${repo_meta.languages.join(", ") || "(unknown)"}`,
    `tests: ${Object.entries(repo_meta.test_frameworks).map(([k,v]) => `${k}:${v}`).join(", ") || "(unknown)"}`,
    `package_manager: ${repo_meta.package_manager}`
  ].join("\n");

  const signalsBlock = JSON.stringify(signals).slice(0, 5000); // keep compact
  const changedCompact = JSON.stringify(changed_files).slice(0, 12000);
  const testsCompact = JSON.stringify(existing_tests).slice(0, 4000);

  const userPayload = {
    instructions: {
      format: "Return ONLY JSON. Do not include prose outside of JSON.",
      caps: { max_comments: requirements.max_comments ?? 3, max_tests: 2 },
      json_schema: jsonSchema
    },
    repo_sketch: repoSketch,
    repo_signals: signalsBlock,
    changed_files: changedCompact,
    existing_tests: testsCompact,
    example
  };

  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(userPayload) }
  ];
}
