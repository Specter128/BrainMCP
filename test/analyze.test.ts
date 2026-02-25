import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/reasoning/analyze.js";
import { getResponsePolicy } from "../src/utils/validation.js";

describe("analyzeTask", () => {
  it("extracts task type, constraints, unknowns, and workflow deterministically", () => {
    const policy = getResponsePolicy({ mode: "small" });
    const result = analyzeTask({
      task: "Debug failing auth endpoint. Must use only SQLite. Cannot use external APIs. Why is it failing?",
      constraints: ["No hidden AI calls."],
      context: {
        domain: "backend"
      },
      policy
    });

    expect(result.taskType).toBe("debugging");
    expect(result.constraints.some((item) => item.toLowerCase().includes("must"))).toBe(true);
    expect(result.constraints.some((item) => item.toLowerCase().includes("cannot"))).toBe(true);
    expect(result.unknowns.length).toBeGreaterThan(0);
    expect(result.suggestedWorkflow).toContain("decompose_task");
    expect(result.risks.length).toBeLessThanOrEqual(policy.maxRisks);
  });
});
