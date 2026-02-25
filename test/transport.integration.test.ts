import { afterEach, describe, expect, it } from "vitest";
import { createRepositories } from "../src/storage/repositories/index.js";
import { createDatabase } from "../src/storage/db.js";
import { startTransport } from "../src/server/transport.js";
import { createLogger } from "../src/server/logger.js";
import { createReasoningOrchestratorServer } from "../src/tools/index.js";
import { createTempDb } from "./helpers/tempDb.js";

describe("transport integration", () => {
  const resources: Array<{
    close: () => Promise<void>;
    db: ReturnType<typeof createDatabase>;
    cleanup: () => void;
  }> = [];

  afterEach(async () => {
    while (resources.length > 0) {
      const item = resources.pop()!;
      await item.close();
      item.cleanup();
    }
  });

  it("handles initialize + tool lifecycle and reports metrics", async () => {
    const temp = createTempDb();
    const transport = await startTransport({
      port: 0,
      authToken: "integration_test_super_secret_token",
      healthPublic: true,
      metricsPublic: false,
      requestTimeoutMs: 20_000,
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 100,
      logger: createLogger("error"),
      createServer: () =>
        createReasoningOrchestratorServer({
          version: "test",
          startedAtMs: Date.now(),
          repositories: createRepositories(temp.db)
        })
    });
    resources.push({
      close: transport.close,
      db: temp.db,
      cleanup: temp.cleanup
    });

    const baseUrl = `http://127.0.0.1:${transport.port}`;
    const initResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer integration_test_super_secret_token",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-05",
          capabilities: {},
          clientInfo: {
            name: "integration-test",
            version: "1.0.0"
          }
        }
      })
    });

    expect(initResponse.status).toBe(200);
    const mcpSessionId = initResponse.headers.get("mcp-session-id");
    expect(mcpSessionId).toBeTruthy();

    const createSessionResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer integration_test_super_secret_token",
        "mcp-session-id": mcpSessionId as string,
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tool-1",
        method: "tools/call",
        params: {
          name: "create_reasoning_session",
          arguments: {
            title: "Integration Session",
            clientProfile: { mode: "small" }
          }
        }
      })
    });
    expect(createSessionResponse.status).toBe(200);
    const createSessionBody = (await parseJsonRpcResponse(createSessionResponse)) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const createdPayload = JSON.parse(
      createSessionBody.result?.content?.[0]?.text ?? "{}"
    ) as { sessionId?: string; status?: string };
    expect(createdPayload.sessionId).toBeTruthy();
    expect(createdPayload.status).toBe("active");

    const metricsResponse = await fetch(`${baseUrl}/metricsz`, {
      method: "GET",
      headers: {
        authorization: "Bearer integration_test_super_secret_token",
        accept: "application/json"
      }
    });
    expect(metricsResponse.status).toBe(200);
    const metricsBody = (await metricsResponse.json()) as {
      mcp?: {
        initializeRequests?: number;
        toolCallsByName?: Record<string, number>;
      };
    };
    expect((metricsBody.mcp?.initializeRequests ?? 0) >= 1).toBe(true);
    expect((metricsBody.mcp?.toolCallsByName?.create_reasoning_session ?? 0) >= 1).toBe(
      true
    );
  });

  it("enforces rate limit when configured aggressively", async () => {
    const temp = createTempDb();
    const transport = await startTransport({
      port: 0,
      authToken: "integration_test_super_secret_token",
      healthPublic: true,
      metricsPublic: false,
      requestTimeoutMs: 20_000,
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 1,
      logger: createLogger("error"),
      createServer: () =>
        createReasoningOrchestratorServer({
          version: "test",
          startedAtMs: Date.now(),
          repositories: createRepositories(temp.db)
        })
    });
    resources.push({
      close: transport.close,
      db: temp.db,
      cleanup: temp.cleanup
    });

    const baseUrl = `http://127.0.0.1:${transport.port}`;
    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "init-limit",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" }
      }
    });

    const first = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer integration_test_super_secret_token",
        accept: "application/json, text/event-stream"
      },
      body: requestBody
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer integration_test_super_secret_token",
        accept: "application/json, text/event-stream"
      },
      body: requestBody
    });
    expect(second.status).toBe(429);
  });
});

async function parseJsonRpcResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }
  const lines = text.split("
");
  const dataLines = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
  for (const payload of dataLines.reverse()) {
    try {
      const parsed = JSON.parse(payload) as { jsonrpc?: string };
      if (parsed.jsonrpc === "2.0") {
        return parsed;
      }
    } catch {
      // Ignore non-JSON data lines.
    }
  }
  throw new Error(`Failed to parse JSON-RPC response. ContentType=${contentType} Body=${text}`);
}
