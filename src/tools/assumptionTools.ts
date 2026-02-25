import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  checkAssumptions,
  classifyAssumptionCategory,
  classifyAssumptionRisk,
  extractAssumptions,
  normalizeAssumptionText
} from "../reasoning/assumptions.js";
import { newId, stableHash } from "../utils/ids.js";
import {
  assumptionCheckInputSchema,
  listAssumptionsInputSchema
} from "../utils/zodSchemas.js";
import {
  buildNextActions,
  ensureSession,
  jsonToolResult,
  resolvePolicy,
  safeToolHandler,
  type ToolContext
} from "./common.js";

export function registerAssumptionTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "list_assumptions",
    {
      description: "Extract and persist assumptions from source text or session state.",
      inputSchema: listAssumptionsInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = listAssumptionsInputSchema.parse(rawArgs);
      const session = ensureSession(context.repositories, args.sessionId);
      const policy = resolvePolicy(args.clientProfile, session.clientProfile);
      const planSteps = context.repositories.plans.listStepsBySession(args.sessionId);
      const logs = context.repositories.decisionLogs.list({
        sessionId: args.sessionId,
        limit: policy.maxDecisionEntries
      });

      const assumptions = extractAssumptions({
        sourceText: args.sourceText,
        includeImplicit: args.includeImplicit ?? true,
        planTitles: args.sourceText ? undefined : planSteps.map((step) => step.title),
        decisionSummaries: args.sourceText ? undefined : logs.map((log) => log.summary),
        policy
      });

      const persisted = context.repositories.assumptions.upsertMany(
        assumptions.map((item) => ({
          assumptionId: item.assumptionId,
          sessionId: args.sessionId,
          text: item.text,
          normalizedHash: item.normalizedHash,
          type: item.type,
          category: item.category,
          status: item.status,
          risk: item.risk
        }))
      );
      context.repositories.sessions.touch(args.sessionId);

      return jsonToolResult({
        assumptions: persisted.map((assumption) => ({
          assumptionId: assumption.assumptionId,
          text: assumption.text,
          type: assumption.type,
          category: assumption.category,
          status: "unverified",
          risk: assumption.risk
        })),
        summary: {
          total: persisted.length,
          highRisk: persisted.filter((item) => item.risk === "high").length
        },
        nextActions: buildNextActions(policy, [
          {
            tool: "assumption_check",
            args: { sessionId: args.sessionId, strictness: "strict" },
            why: "Extracted assumptions must be verified before execution."
          },
          {
            tool: "next_best_action",
            args: { sessionId: args.sessionId, preference: "safety" },
            why: "Assumption risk should influence immediate action selection."
          }
        ])
      });
    })
  );

  server.registerTool(
    "assumption_check",
    {
      description: "Deterministically classify assumptions by evidence and conflicts.",
      inputSchema: assumptionCheckInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = assumptionCheckInputSchema.parse(rawArgs);
      const session = ensureSession(context.repositories, args.sessionId);
      const policy = resolvePolicy(args.clientProfile, session.clientProfile);
      const strictness = args.strictness ?? "standard";
      const allAssumptions = context.repositories.assumptions.listBySession(args.sessionId);
      const planSteps = context.repositories.plans.listStepsBySession(args.sessionId);
      const logs = context.repositories.decisionLogs.list({
        sessionId: args.sessionId,
        limit: policy.maxDecisionEntries
      });

      const checks = args.checks?.length
        ? hydrateChecks(args.checks, getAssumptionLookup(allAssumptions))
        : allAssumptions.map((assumption) => ({
            assumptionId: assumption.assumptionId,
            text: assumption.text,
            category: assumption.category,
            risk: assumption.risk,
            evidenceAvailable: [],
            statusHint: undefined
          }));

      const conflictsMap = new Map(
        checks.map((check) => [
          check.assumptionId ?? check.text,
          detectSessionConflict(check.text, planSteps, logs)
        ])
      );

      const evaluated = checkAssumptions({
        strictness,
        policy,
        checks: checks.map((check) => ({
          ...check,
          sessionConflicts: conflictsMap.get(check.assumptionId ?? check.text) ?? false
        }))
      });

      context.repositories.assumptions.updateStatuses(
        args.sessionId,
        evaluated.results.map((item) => ({
          assumptionId: item.assumptionId,
          normalizedHash: item.assumptionId ? undefined : stableHash(normalizeAssumptionText(item.text)),
          status: item.status,
          confidence: item.confidence,
          evidenceNeeded: item.evidenceNeeded
        }))
      );
      context.repositories.sessions.touch(args.sessionId);

      return jsonToolResult({
        results: evaluated.results,
        summary: evaluated.summary,
        nextActions: buildNextActions(policy, [
          {
            tool: "consistency_check",
            args: { sessionId: args.sessionId, checkTargets: ["unsupported-claims", "goal-drift"] },
            why: "Assumption status changes can invalidate conclusions."
          },
          {
            tool: "next_best_action",
            args: { sessionId: args.sessionId, preference: "safety" },
            why: "Updated assumption risk should drive next action."
          }
        ])
      });
    })
  );
}

function hydrateChecks(
  checks: NonNullable<ReturnType<typeof assumptionCheckInputSchema.parse>["checks"]>,
  existing: ReturnType<typeof getAssumptionLookup>
): Array<{
  assumptionId?: string;
  text: string;
  category: ReturnType<typeof classifyAssumptionCategory>;
  risk: ReturnType<typeof classifyAssumptionRisk>;
  evidenceAvailable?: string[];
  statusHint?: "verified" | "unverified" | "risky";
}> {
  const lookup = existing;
  return checks.map((check) => {
    if (check.assumptionId && lookup.byId.has(check.assumptionId)) {
      const current = lookup.byId.get(check.assumptionId)!;
      return {
        assumptionId: current.assumptionId,
        text: check.text ?? current.text,
        category: current.category,
        risk: current.risk,
        evidenceAvailable: check.evidenceAvailable ?? [],
        statusHint: check.statusHint
      };
    }

    const text = check.text ?? "";
    const normalizedHash = stableHash(normalizeAssumptionText(text));
    const existingByHash = lookup.byHash.get(normalizedHash);
    if (existingByHash) {
      return {
        assumptionId: existingByHash.assumptionId,
        text,
        category: existingByHash.category,
        risk: existingByHash.risk,
        evidenceAvailable: check.evidenceAvailable ?? [],
        statusHint: check.statusHint
      };
    }

    return {
      assumptionId: newId("assumption"),
      text,
      category: classifyAssumptionCategory(text),
      risk: classifyAssumptionRisk(text),
      evidenceAvailable: check.evidenceAvailable ?? [],
      statusHint: check.statusHint
    };
  });
}

function getAssumptionLookup(
  assumptions: ReturnType<ToolContext["repositories"]["assumptions"]["listBySession"]>
): {
  byId: Map<string, (typeof assumptions)[number]>;
  byHash: Map<string, (typeof assumptions)[number]>;
} {
  return {
    byId: new Map(assumptions.map((item) => [item.assumptionId, item] as const)),
    byHash: new Map(assumptions.map((item) => [item.normalizedHash, item] as const))
  };
}

function detectSessionConflict(
  assumptionText: string,
  steps: ReturnType<ToolContext["repositories"]["plans"]["listStepsBySession"]>,
  logs: ReturnType<ToolContext["repositories"]["decisionLogs"]["list"]>
): boolean {
  const text = assumptionText.toLowerCase();
  if (/\bno blocker|unblocked\b/.test(text) && steps.some((step) => step.status === "blocked")) {
    return true;
  }
  if (/\bdependency available|all dependencies ready\b/.test(text)) {
    const riskDependencyLog = logs.some(
      (log) =>
        log.kind === "risk" &&
        /\bdependency|integration|missing|unavailable\b/i.test(log.summary)
    );
    if (riskDependencyLog) {
      return true;
    }
  }
  if (/\ball tests pass|verified\b/.test(text)) {
    const hasPositiveResult = logs.some(
      (log) => log.kind === "result" && /\bpass|verified|success\b/i.test(log.summary)
    );
    return !hasPositiveResult;
  }
  return false;
}
