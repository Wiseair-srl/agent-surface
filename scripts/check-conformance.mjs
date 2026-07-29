#!/usr/bin/env node
/**
 * Conformance gate (docs/17 §4.2, docs/18 consequences). Fails CI when:
 *  - a requirement's source document (docs/<file>#<anchor>) does not exist;
 *  - an "implemented" requirement lists no tests, a listed test file is
 *    missing, or the file never mentions the requirement ID;
 *  - a "specified" requirement lacks a written justification;
 *  - a test file references an AS-… ID unknown to the manifest;
 *  - spec/error-matrix.json and the implemented error enum drift apart.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

/* ── conformance manifest ─────────────────────────────────────────────── */

const manifest = JSON.parse(readFileSync(join(root, "spec/conformance.json"), "utf8"));
const requirements = manifest.requirements ?? {};
const idPattern = /^AS-[A-Z]+-\d{3}$/;

for (const [id, req] of Object.entries(requirements)) {
  if (!idPattern.test(id)) problems.push(`${id}: malformed requirement id`);
  const [sourceFile] = (req.source ?? "").split("#");
  if (!sourceFile || !existsSync(join(root, "docs", sourceFile))) {
    problems.push(`${id}: source document docs/${sourceFile} not found`);
  }
  const tests = req.tests ?? [];
  for (const test of tests) {
    const path = join(root, test);
    if (!existsSync(path)) {
      problems.push(`${id}: test file ${test} not found`);
    } else if (!readFileSync(path, "utf8").includes(id)) {
      problems.push(`${id}: test file ${test} never mentions the requirement id`);
    }
  }
  if (req.status === "implemented" && tests.length === 0) {
    problems.push(`${id}: status "implemented" requires at least one test`);
  }
  if (req.status === "specified" && !req.justification) {
    problems.push(`${id}: status "specified" requires a written justification`);
  }
  if (!["implemented", "specified", "deprecated"].includes(req.status)) {
    problems.push(`${id}: unknown status "${req.status}"`);
  }
}

/* ── no orphan IDs in test files ──────────────────────────────────────── */

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.test\.tsx?$/.test(entry)) yield path;
  }
}
for (const file of walk(join(root, "packages"))) {
  const content = readFileSync(file, "utf8");
  for (const match of content.matchAll(/AS-[A-Z]+-\d{3}/g)) {
    if (!requirements[match[0]]) {
      problems.push(`${file.slice(root.length + 1)}: references unknown requirement ${match[0]}`);
    }
  }
}

/* ── error matrix ↔ implementation lockstep ───────────────────────────── */

const matrix = JSON.parse(readFileSync(join(root, "spec/error-matrix.json"), "utf8"));
const errorsTs = readFileSync(join(root, "packages/core/src/errors.ts"), "utf8");
const enumBlock = errorsTs.match(/AGENT_CAPABILITY_ERROR_CODES = \[([\s\S]*?)\]/)?.[1] ?? "";
const implementedCodes = new Set([...enumBlock.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]));
const matrixCodes = new Set(Object.keys(matrix.codes ?? {}));
for (const code of implementedCodes) {
  if (!matrixCodes.has(code)) problems.push(`error-matrix: implemented code ${code} missing from spec/error-matrix.json`);
}
for (const code of matrixCodes) {
  if (!implementedCodes.has(code)) problems.push(`error-matrix: ${code} in spec/error-matrix.json but not implemented`);
}
const retryTs = errorsTs.match(/AgentErrorRetry =([\s\S]*?);/)?.[1] ?? "";
const retryValues = new Set([...retryTs.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
for (const [code, row] of Object.entries(matrix.codes ?? {})) {
  for (const retry of row.retry ?? []) {
    if (!retryValues.has(retry)) problems.push(`error-matrix: ${code} lists unknown retry "${retry}"`);
  }
  if (!Array.isArray(row.phases) || row.phases.some((p) => !(Number.isInteger(p) && p >= 1 && p <= 10))) {
    problems.push(`error-matrix: ${code} phases must be integers in 1..10`);
  }
  if (typeof row.cacheable !== "boolean") problems.push(`error-matrix: ${code} missing cacheable`);
}

/* ── report ───────────────────────────────────────────────────────────── */

if (problems.length > 0) {
  console.error(`conformance check FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const implemented = Object.values(requirements).filter((r) => r.status === "implemented").length;
const specified = Object.values(requirements).filter((r) => r.status === "specified").length;
console.log(
  `conformance check OK: ${Object.keys(requirements).length} requirements (${implemented} implemented, ${specified} specified), ${matrixCodes.size} error codes in lockstep.`,
);
