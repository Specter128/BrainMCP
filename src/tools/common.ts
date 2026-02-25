import type { Repositories } from "../storage/repositories/index.js";
import type { SessionRecord } from "../storage/repositories/sessions.js";
import { capItems, getResponsePolicy, type ClientProfile, type ResponsePolicy } from "../utils/validation.js";

export type ToolContext = {
  version: string;
  startedAtMs: number;
  repositories: Repositories;
};

export type NextActionSuggestion = {
  tool: string;
  args: Record<string, unknown>;
  why: string;
};

export type JsonToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function jsonToolResult(payload: unknown): JsonToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload)
      }
    ]
  };
}

export function jsonToolError(
  code: string,
  message: string,
  hint?: string
): JsonToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code,
            message,
            ...(hint ? { hint } : {})
          }
        })
      }
    ]
  };
}

export function safeToolHandler<TArgs>(
  handler: (args: TArgs) => Promise<JsonToolResult> | JsonToolResult
): (args: TArgs, _extra: unknown) => Promise<JsonToolResult> {
  return async (args: TArgs) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown tool error";
      return jsonToolError("TOOL_EXECUTION_ERROR", message);
    }
  };
}

export function ensureSession(
  repositories: Repositories,
  sessionId: string
): SessionRecord {
  const session = repositories.sessions.getById(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return session;
}

export function resolvePolicy(
  explicitProfile?: ClientProfile,
  sessionProfile?: ClientProfile
): ResponsePolicy {
  return getResponsePolicy(explicitProfile ?? sessionProfile);
}

export function buildNextActions(
  policy: ResponsePolicy,
  actions: NextActionSuggestion[]
): NextActionSuggestion[] {
  return capItems(actions, policy.maxActionSuggestions).map((action) => ({
    ...action,
    why: action.why.slice(0, policy.textMaxChars)
  }));
}
