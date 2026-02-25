import { secondsSince } from "../utils/time.js";

type RequestCounters = {
  total: number;
  byPath: Map<string, number>;
  byStatusCode: Map<string, number>;
  latencyTotalMs: number;
  latencyMaxMs: number;
};

export class MetricsCollector {
  private readonly startedAtMs = Date.now();
  private readonly requests: RequestCounters = {
    total: 0,
    byPath: new Map<string, number>(),
    byStatusCode: new Map<string, number>(),
    latencyTotalMs: 0,
    latencyMaxMs: 0
  };
  private readonly authFailures = { total: 0 };
  private readonly rateLimit = { exceededTotal: 0 };
  private readonly requestTimeout = { total: 0 };
  private readonly mcp = {
    initializeTotal: 0,
    toolCallTotal: 0,
    toolCallsByName: new Map<string, number>()
  };

  observeHttpRequest(path: string, statusCode: number, latencyMs: number): void {
    this.requests.total += 1;
    this.requests.byPath.set(path, (this.requests.byPath.get(path) ?? 0) + 1);
    const statusBucket = String(statusCode);
    this.requests.byStatusCode.set(
      statusBucket,
      (this.requests.byStatusCode.get(statusBucket) ?? 0) + 1
    );
    this.requests.latencyTotalMs += latencyMs;
    this.requests.latencyMaxMs = Math.max(this.requests.latencyMaxMs, latencyMs);
  }

  recordAuthFailure(): void {
    this.authFailures.total += 1;
  }

  recordRateLimitExceeded(): void {
    this.rateLimit.exceededTotal += 1;
  }

  recordRequestTimeout(): void {
    this.requestTimeout.total += 1;
  }

  recordMcpInitialize(): void {
    this.mcp.initializeTotal += 1;
  }

  recordMcpToolCall(toolName: string): void {
    this.mcp.toolCallTotal += 1;
    this.mcp.toolCallsByName.set(
      toolName,
      (this.mcp.toolCallsByName.get(toolName) ?? 0) + 1
    );
  }

  snapshot(activeSessions: { streamable: number; sse: number }): Record<string, unknown> {
    const avgLatencyMs =
      this.requests.total > 0
        ? roundTwo(this.requests.latencyTotalMs / this.requests.total)
        : 0;
    return {
      time: new Date().toISOString(),
      uptimeSec: secondsSince(this.startedAtMs),
      http: {
        totalRequests: this.requests.total,
        byPath: mapToSortedObject(this.requests.byPath),
        byStatusCode: mapToSortedObject(this.requests.byStatusCode),
        avgLatencyMs,
        maxLatencyMs: this.requests.latencyMaxMs
      },
      auth: {
        failures: this.authFailures.total
      },
      rateLimit: {
        exceeded: this.rateLimit.exceededTotal
      },
      requestTimeout: {
        triggered: this.requestTimeout.total
      },
      mcp: {
        initializeRequests: this.mcp.initializeTotal,
        toolCalls: this.mcp.toolCallTotal,
        toolCallsByName: mapToSortedObject(this.mcp.toolCallsByName)
      },
      sessions: {
        streamable: activeSessions.streamable,
        sse: activeSessions.sse
      }
    };
  }
}

function mapToSortedObject(input: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...input.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}
