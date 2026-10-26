// Prints which of Saifuro's verdict test vectors pass: pnpm --filter @agent-spend-tracer/api verdict:vectors
import { fileURLToPath } from "node:url";
import { loadVectors, runAll } from "./vectors.js";

const path = process.argv[2] ?? fileURLToPath(new URL("../../test/fixtures/saifuro/verdict-test-vectors.json", import.meta.url));
const results = await runAll(loadVectors(path));

const show = (step: number | null) => (step === null ? "accept" : `step ${step}`);
for (const r of results) {
  const mark = r.pass ? (r.stepMatches ? "PASS" : "PASS*") : "FAIL";
  const detail = r.pass && r.stepMatches ? "" : `  expected ${show(r.expected.step)}, got ${show(r.step)}${r.reason ? ` (${r.reason})` : ""}`;
  console.log(`${mark.padEnd(5)} ${r.mode.padEnd(6)} ${r.id}${detail}`);
}

const passed = results.filter((r) => r.pass).length;
const stepMismatch = results.filter((r) => r.pass && !r.stepMatches).length;
const accepts = results.filter((r) => r.expected.valid);
console.log(
  `\n${passed}/${results.length} pass (valid matches expected)` +
    `; accepts ${accepts.filter((r) => r.pass).length}/${accepts.length}, rejects ${results.filter((r) => !r.expected.valid && r.pass).length}/${results.length - accepts.length}` +
    `; ${stepMismatch} rejected at a different step than expected (marked PASS*)`,
);
process.exitCode = passed === results.length ? 0 : 1;
