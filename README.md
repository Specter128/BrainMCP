# Reasoning Orchestrator MCP

Deterministic-first standalone MCP server for structured reasoning orchestration.

## Quickstart

```bash
docker build -t reasoning-mcp .
docker run -p 8080:8080 -e MCP_AUTH_TOKEN=your_secret_token reasoning-mcp
```

## Features
- Structured workflow tools.
- SQLite persistence.
- SSE & Streamable HTTP support.
