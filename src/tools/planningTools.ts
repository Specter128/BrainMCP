import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeTask } from "../reasoning/analyze.js";
import { decomposeTask } from "../reasoning/decompose.js";
import { selectNextBestAction } from "../reasoning/nextAction.js";
import { buildPlan } from "../reasoning/plan.js";
import { newId } from "../utils/ids.js";
import {
  analyzeTaskInputSchema,
  buildPlanInputSchema,
  decomposeTaskInputSchema,
  nextBestActionInputSchema,
  updatePlanStatusInputSchema
} from "../utils/zodSchemas.js";
import { truncateText } from "../utils/truncation.js";
import {
  buildNextActions,
  ensureSession,
  jsonToolError,
  jsonToolResult,
  resolvePolicy,
  safeToolHandler,
  type ToolContext
} from "./common.js";

export function registerPlanningTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "analyze_task",
    {
      description: "Deterministically extract goal, unknowns, risks and workflow.",
      inputSchema: analyzeTaskInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = analyzeTaskInputSchema.parse(rawArgs);
      const session = args.sessionId ? context.repositories.sessions.getById(args.sessionId) : null;
      const policy = resolvePolicy(args.clientProfile, session?.clientProfile);
      const analysis = analyzeTask({
        task: args.task,
        constraints: args.constraints,
        context: args.context,
        policy
      });

      return jsonToolResult({
        task: analysis.task,
        normalizedGoal: analysis.normalizedGoal,
        taskType: analysis.taskType,
        constraints: analysis.constraints,
        assumptionsImplicit: analysis.assumptionsImplicit,
        unknowns: analysis.unknowns,
        risks: analysis.risks,
        successCriteria: analysis.successCriteria,
        clarificationsNeeded: analysis.clarificationsNeeded,
        suggestedWorkflow: analysis.suggestedWorkflow,
        nextActions: buildNextActions(policy, [
          {
            tool: "decompose_task",
            args: {
              ...(args.sessionId ? { sessionId: args.sessionId } : {}),
              task: args.task,
              goal: analysis.normalizedGoal
            },
            why: "Task decomposition is required before reliable planning."
          },
          {
            tool: "list_assumptions",
            args: {
              ...(args.sessionId ? { sessionId: args.sessionId } : {}),
              sourceText: args.task
            },
            why: "Unknowns imply implicit assumptions that need tracking."
          }
        ])
      });
    })
  );

  server.registerTool(
    "decompose_task",
    {
      description: "Deterministically decompose task into subtasks with dependencies.",
      inputSchema: decomposeTaskInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = decomposeTaskInputSchema.parse(rawArgs);
      const session = args.sessionId ? context.repositories.sessions.getById(args.sessionId) : null;
      const policy = resolvePolicy(args.clientProfile, session?.clientProfile);
      const decomposition = decomposeTask({
        task: args.task,
        goal: args.goal,
        constraints: args.constraints,
        mode: args.mode,
        policy
      });

      const nextActions = buildNextActions(policy, [
        {
          tool: "build_plan",
          args: {
            ...(args.sessionId ? { sessionId: args.sessionId } : {}),
            goal: truncateText(args.goal ?? args.task, policy.textMaxChars),
            subtasks: decomposition.subtasks.map((subtask) => ({
              id: subtask.id,
              title: subtask.title,
              dependsOn: subtask.dependsOn
            }))
          },
          why: "Plan generation requires explicit subtask ordering."
        },
        {
          tool: "consistency_check",
          args: {
            draft: {
              steps: decomposition.subtasks.map((subtask) => ({
                id: subtask.id,
                text: subtask.title,
                dependsOn: subtask.dependsOn
              }))
            },
            checkTargets: ["circular-deps", "missing-steps"]
          },
          why: "Dependency checks should run before execution."
        }
      ]);

      return jsonToolResult({
        decompositionMode: decomposition.decompositionMode,
        subtasks: decomposition.subtasks,
        criticalPath: decomposition.criticalPath,
        parallelizableGroups: decomposition.parallelizableGroups,
        nextActions
      });
    })
  );

  server.registerTool(
    "build_plan",
    {
      description: "Create and persist execution plan with deterministic checkpoints.",
      inputSchema: buildPlanInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = buildPlanInputSchema.parse(rawArgs);
      const session = ensureSession(context.repositories, args.sessionId);
      const policy = resolvePolicy(args.clientProfile, session.clientProfile);

      const plan = buildPlan({
        goal: args.goal,
        subtasks: args.subtasks,
        constraints: args.constraints,
        strategy: args.strategy,
        includeCheckpoints: args.includeCheckpoints,
        policy
      });

      const planId = newId("plan");
      context.repositories.plans.createPlanWithSteps({
        planId,
        sessionId: args.sessionId,
        goal: args.goal,
        strategy: plan.strategy,
        steps: plan.steps.map((step) => ({
          stepId: step.stepId,
          orderIndex: step.order,
          title: step.title,
          objective: step.objective,
          dependsOn: step.dependsOn,
          status: "pending",
          verification: step.verification,
          risk: step.risk
        }))
      });
      context.repositories.sessions.touch(args.sessionId);

      const nextActions = buildNextActions(policy, [
        {
          tool: "list_assumptions",
          args: { sessionId: args.sessionId },
          why: "Plan dependencies should be validated against assumptions."
        },
        {
          tool: "next_best_action",
          args: { sessionId: args.sessionId, preference: "progress" },
          why: "Execution should start from best scored action."
        }
      ]);

      return jsonToolResult({
        planId,
        strategy: plan.strategy,
        steps: plan.steps,
        checkpoints: plan.checkpoints,
        planSummary: plan.planSummary,
        nextActions
      });
    })
  );

  server.registerTool(
    "update_plan_status",
    {
      description: "Update plan step statuses and return progress summary.",
      inputSchema: updatePlanStatusInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = updatePlanStatusInputSchema.parse(rawArgs);
      const session = ensureSession(context.repositories, args.sessionId);
      const policy = resolvePolicy(undefined, session.clientProfile);
      const updated = context.repositories.plans.updateStatuses(args.sessionId, args.updates);

      if (updated === 0) {
        return jsonToolError(
          "PLAN_STEP_NOT_FOUND",
          "No plan steps were updated for the provided session/step IDs.",
          "Call build_plan first or verify stepId values."
        );
      }
      context.repositories.sessions.touch(args.sessionId);

      const progress = context.repositories.plans.getProgress(args.sessionId);
      const blockers = context.repositories.plans.listBlockers(args.sessionId);

      const nextActions = buildNextActions(policy, [
        ...(blockers.length > 0
          ? [
              {
                tool: "next_best_action",
                args: { sessionId: args.sessionId, preference: "unblock" },
                why: "Blocked steps require immediate resolution."
              }
            ]
          : [
              {
                tool: "next_best_action",
                args: { sessionId: args.sessionId, preference: "progress" },
                why: "Plan status changed; recompute next action."
              }
            ])
      ]);

      return jsonToolResult({
        ok: true,
        sessionId: args.sessionId,
        updated,
        planProgress: progress,
        blockers,
        nextActions
      });
    })
  );

  server.registerTool(
    "next_best_action",
    {
      description: "Select one best next action with deterministic scoring.",
      inputSchema: nextBestActionInputSchema
    },
    safeToolHandler(async (rawArgs) => {
      const args = nextBestActionInputSchema.parse(rawArgs);
      const session = ensureSession(context.repositories, args.sessionId);
      const policy = resolvePolicy(args.clientProfile, session.clientProfile);

      const planSteps = context.repositories.plans.listStepsBySession(args.sessionId);
      const assumptions = context.repositories.assumptions.listBySession(args.sessionId);
      const decisionLogs = context.repositories.decisionLogs.list({
        sessionId: args.sessionId,
        limit: policy.maxDecisionEntries
      });

      const result = selectNextBestAction({
        planSteps,
        assumptions,
        decisionLogs,
        currentContext: args.currentContext,
        preference: args.preference,
        policy
      });

      const nextActions = buildNextActions(policy, [
        mapRecommendationToTool(args.sessionId, result.recommendation.type, result.recommendation.targetStepId),
        {
          tool: "write_decision_log",
          args: {
            sessionId: args.sessionId,
            kind: "decision",
            summary: `Selected next action: ${result.recommendation.type}`
          },
          why: "Persist recommendation decision for continuity."
        }
      ]);

      return jsonToolResult({
        recommendation: result.recommendation,
        alternatives: result.alternatives,
        prerequisites: result.prerequisites,
        nextActions
      });
    })
  );
}

function mapRecommendationToTool(
  sessionId: string,
  type: "execute-step" | "verify-assumption" | "run-review" | "resolve-blocker" | "revise-plan" | "gather-evidence",
  targetStepId?: string
): { tool: string; args: Record<string, unknown>; why: string } {
  switch (type) {
    case "verify-assumption":
      return {
        tool: "assumption_check",
        args: { sessionId, strictness: "strict" },
        why: "Recommendation prioritizes assumption verification."
      };
    case "run-review":
      return {
        tool: "critic_review",
        args: {
          sessionId,
          subject: { type: "plan" }
        },
        why: "Recommendation requires structured review."
      };
    case "resolve-blocker":
      return {
        tool: "update_plan_status",
        args: {
          sessionId,
          updates: targetStepId
            ? [{ stepId: targetStepId, status: "in_progress" }]
            : []
        },
        why: "Mark blocker as active resolution work after mitigation starts."
      };
    case "revise-plan":
      return {
        tool: "build_plan",
        args: {
          sessionId,
          goal: "Revise plan to handle blockers and maintain progress.",
          strategy: "minimum-risk"
        },
        why: "Recommendation requires plan restructuring."
      };
    case "gather-evidence":
      return {
        tool: "write_decision_log",
        args: {
          sessionId,
          kind: "observation",
          summary: "Collect evidence for current assumption/risk set."
        },
        why: "Evidence capture should be logged before further conclusions."
      };
    default:
      return {
        tool: "update_plan_status",
        args: {
          sessionId,
          updates: targetStepId ? [{ stepId: targetStepId, status: "in_progress" }] : []
        },
        why: "Start or continue execution of selected step."
      };
  }
}
