import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compactReasoningState } from "../reasoning/compact.js";
import { runConsistencyCheck } from "../reasoning/consistency.js";
import { runCriticReview } from "../reasoning/critic.js";
import {
  compactReasoningStateInputSchema,
  consistencyCheckInputSchema,
  criticReviewInputSchema
} from "../utils/zodSchemas.js";
import {
  buildNextActions,
  ensureSession,
  jsonToolResult,
  resolvePolicy,
  safeToolHandler,
  type ToolContext
} from "./common.js";

export function registerQualityTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "consistency_check",
    {
      description: "Detect contradictions, dependency issues, unsupported claims, and goal drift.",
      inputSchema: consistencyCheckInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = consistencyCheckInputSchema.parse(rawArgs);
      const session = args.sessionId ? context.repositories.sessions.getById(args.sessionId) : null;
      const policy = resolvePolicy(args.clientProfile, session?.clientProfile);
      const plan = args.sessionId ? context.repositories.plans.getLatestPlan(args.sessionId) : null;
      const planSteps = args.sessionId ? context.repositories.plans.listStepsBySession(args.sessionId) : [];
      const assumptions = args.sessionId
        ? context.repositories.assumptions.listBySession(args.sessionId)
        : [];
      const logs = args.sessionId
        ? context.repositories.decisionLogs.list({
            sessionId: args.sessionId,
            limit: policy.maxDecisionEntries
          })
        : [];

      const result = runConsistencyCheck({
        draft: args.draft,
        checkTargets: args.checkTargets,
        normalizedGoal: plan?.goal,
        sessionPlanSteps: planSteps,
        sessionAssumptions: assumptions,
        recentDecisionLogs: logs,
        policy
      });

      return jsonToolResult({
        issues: result.issues,
        summary: result.summary,
        nextActions: buildNextActions(policy, [
          ...(result.summary.pass
            ? [
                {
                  tool: args.sessionId ? "next_best_action" : "decompose_task",
                  args: args.sessionId
                    ? { sessionId: args.sessionId, preference: "progress" }
                    : { task: args.draft?.planText ?? "Continue workflow" },
                  why: "Consistency checks passed; proceed with execution."
                }
              ]
            : [
                {
                  tool: "build_plan",
                  args: args.sessionId
                    ? {
                        sessionId: args.sessionId,
                        goal: plan?.goal ?? "Revise inconsistent plan",
                        strategy: "minimum-risk"
                      }
                    : {
                        sessionId: "missing-session",
                        goal: "Revise inconsistent plan",
                        strategy: "minimum-risk"
                      },
                  why: "Detected issues require plan revisions."
                },
                {
                  tool: "critic_review",
                  args: {
                    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
                    subject: {
                      type: "plan",
                      structured: {
                        issues: result.issues
                      }
                    }
                  },
                  why: "Run rubric review after consistency fixes."
                }
              ])
        ])
      });
    })
  );

  server.registerTool(
    "critic_review",
    {
      description: "Deterministic rubric-based quality review.",
      inputSchema: criticReviewInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = criticReviewInputSchema.parse(rawArgs);
      const session = args.sessionId ? context.repositories.sessions.getById(args.sessionId) : null;
      const policy = resolvePolicy(args.clientProfile, session?.clientProfile);

      const subjectText = args.subject.text ?? materializeSubjectText(args.sessionId, context);
      const result = runCriticReview({
        subject: {
          ...args.subject,
          text: subjectText
        },
        rubric: args.rubric,
        style: args.style,
        policy
      });

      return jsonToolResult({
        ...result,
        nextActions: buildNextActions(policy, [
          ...(result.verdict === "approve"
            ? [
                {
                  tool: args.sessionId ? "next_best_action" : "consistency_check",
                  args: args.sessionId
                    ? { sessionId: args.sessionId, preference: "progress" }
                    : { draft: { conclusions: ["Approved draft ready for next step."] } },
                  why: "Approved review can move to execution."
                }
              ]
            : [
                {
                  tool: "consistency_check",
                  args: {
                    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
                    draft: {
                      planText: subjectText
                    }
                  },
                  why: "Revisions should pass consistency checks before approval."
                }
              ])
        ])
      });
    })
  );

  server.registerTool(
    "compact_reasoning_state",
    {
      description: "Compress session state into deterministic token-efficient working memory.",
      inputSchema: compactReasoningStateInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = compactReasoningStateInputSchema.parse(rawArgs);
      const session = ensureSession(context.repositories, args.sessionId);
      const policy = resolvePolicy(args.clientProfile, session.clientProfile);
      const plan = context.repositories.plans.getLatestPlan(args.sessionId);
      const planSteps = context.repositories.plans.listStepsBySession(args.sessionId);
      const assumptions = context.repositories.assumptions.listBySession(args.sessionId);
      const logs = context.repositories.decisionLogs.list({
        sessionId: args.sessionId,
        limit: policy.maxDecisionEntries
      });

      const constraints = logs
        .filter((log) => log.kind === "note" || log.kind === "decision")
        .map((log) => log.summary)
        .filter((summary) => /\bmust|cannot|only|strict|constraint\b/i.test(summary))
        .slice(0, policy.maxGenericItems);

      const compacted = compactReasoningState({
        targetTokens: args.targetTokens,
        preserve: args.preserve,
        goal: plan?.goal ?? session.title ?? undefined,
        constraints,
        planSteps,
        assumptions,
        decisionLogs: logs,
        policy
      });

      context.repositories.sessions.updateCompactState(args.sessionId, compacted.compactState);

      return jsonToolResult({
        ok: true,
        sessionId: args.sessionId,
        beforeEstimatedTokens: compacted.beforeEstimatedTokens,
        afterEstimatedTokens: compacted.afterEstimatedTokens,
        compactStatePreview: compacted.compactState,
        preservedSections: compacted.preservedSections,
        droppedOrCompressedSections: compacted.droppedOrCompressedSections,
        nextActions: buildNextActions(policy, [
          {
            tool: "get_reasoning_session",
            args: { sessionId: args.sessionId },
            why: "Confirm compact state persisted in session record."
          },
          {
            tool: "next_best_action",
            args: { sessionId: args.sessionId, preference: "progress" },
            why: "Use compact state to continue execution with low token cost."
          }
        ])
      });
    })
  );
}

function materializeSubjectText(sessionId: string | undefined, context: ToolContext): string | undefined {
  if (!sessionId) {
    return undefined;
  }
  const plan = context.repositories.plans.getLatestPlan(sessionId);
  const steps = context.repositories.plans.listStepsBySession(sessionId);
  const assumptions = context.repositories.assumptions.listBySession(sessionId);
  const logs = context.repositories.decisionLogs.list({ sessionId, limit: 20 });
  if (!plan && steps.length === 0 && assumptions.length === 0 && logs.length === 0) {
    return undefined;
  }
  return JSON.stringify({
    goal: plan?.goal,
    strategy: plan?.strategy,
    stepStatuses: steps.map((step) => ({ stepId: step.stepId, status: step.status, risk: step.risk })),
    assumptions: assumptions.map((assumption) => ({
      text: assumption.text,
      status: assumption.status,
      risk: assumption.risk
    })),
    recentLogs: logs.map((log) => ({ kind: log.kind, summary: log.summary }))
  });
}
