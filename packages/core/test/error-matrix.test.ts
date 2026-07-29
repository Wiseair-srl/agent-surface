/**
 * The error matrix and the implementation stay in lockstep from one source
 * (docs/07 §principles, docs/17 §4.4). Requirement: AS-ERR-001.
 */
import { describe, expect, it } from "vitest";
import { AGENT_CAPABILITY_ERROR_CODES } from "../src/errors.js";
import rawMatrix from "../../../spec/error-matrix.json";

interface MatrixRow {
  phases: number[];
  retry: string[];
  cacheable: boolean;
  details: string[];
}

const matrix = rawMatrix as unknown as { codes: Record<string, MatrixRow> };

const RETRY_VALUES = ["no", "yes", "after-refresh", "after-delay", "with-confirmation", "with-changes"];

describe("spec/error-matrix.json ↔ implementation lockstep (AS-ERR-001)", () => {
  it("covers exactly the implemented closed enum", () => {
    expect(Object.keys(matrix.codes).sort()).toEqual([...AGENT_CAPABILITY_ERROR_CODES].sort());
  });

  it("every row is well-formed: phases 1..10, known retry values, cacheable flag", () => {
    for (const [code, row] of Object.entries(matrix.codes)) {
      expect(row.phases.length, `${code} phases`).toBeGreaterThan(0);
      for (const phase of row.phases) {
        expect(Number.isInteger(phase) && phase >= 1 && phase <= 10, `${code} phase ${phase}`).toBe(true);
      }
      expect(row.retry.length, `${code} retry`).toBeGreaterThan(0);
      for (const retry of row.retry) {
        expect(RETRY_VALUES, `${code} retry ${retry}`).toContain(retry);
      }
      expect(typeof row.cacheable, `${code} cacheable`).toBe("boolean");
    }
  });

  it("expected-retry protocol steps are never cacheable", () => {
    expect(matrix.codes.CONFIRMATION_REQUIRED?.cacheable).toBe(false);
    expect(matrix.codes.RATE_LIMITED?.cacheable).toBe(false);
    expect(matrix.codes.INVOCATION_CONFLICT?.cacheable).toBe(false);
  });
});
