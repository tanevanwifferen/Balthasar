# LLM Orchestrator CLI with MCP Agents (TypeScript)

A TypeScript CLI that:
- Chats with OpenAI models
- Connects to MCP servers over stdio (via @modelcontextprotocol/sdk)
- Exposes MCP tools to the model only when running under an agent scope
- Supports prompt templates and a multi-agent orchestration pattern via a virtual call_agent tool

This project replaces an earlier Python CLI with a cleaner, strongly-typed implementation in Node/TypeScript.

Core entry point: [src/bin/llm.ts](src/bin/llm.ts)

## Why this is different from a generic MCP CLI

- Default (no agent) mode is an “orchestrator” without any tools for safety.
- Tools become available only when you run with an explicit agent scope (e.g. --agent researcher). Per-agent policy defines which servers and tools are exposed.
- A virtual function tool, [TypeScript.chatWithOpenAI()](src/lib/llm-core.ts:89) adds call_agent, enabling agents to delegate to other agents within configured allowlists.

Key implementations:
- Config loader: [TypeScript.loadConfig()](src/lib/config.ts:29)
- Tool discovery and scoping: [TypeScript.setupTools()](src/lib/mcp.ts:148)
- List tools across servers (for inspection): [TypeScript.listAllTools()](src/lib/mcp.ts:83)
- Agent loading and merging: [TypeScript.loadAgents()](src/lib/agents.ts:62), [TypeScript.listAgents()](src/lib/agents.ts:95)
- OpenAI client creation: [TypeScript.makeOpenAI()](src/lib/llm-core.ts:57)
- Prompt templates registry: [src/prompts.ts](src/prompts.ts)

## Install

```bash
npm install
npm run build
```

This builds the llm CLI to dist/bin/llm.js and registers it for npm bin via package.json. When published, it will be available as the llm command.

For local runs without publish:
- node dist/bin/llm.js ...
- or npm start which runs node ./dist/bin/llm.js

## Configure

Create a config file at one of:
- ./mcp-server-config.json
- ~/.llm/config.json

See the example at: [mcp-server-config-example.json](mcp-server-config-example.json)

Notes:
- OpenAI key is read from config llm.api_key or env OPENAI_API_KEY / LLM_API_KEY.
- MCP servers can be connected via stdio (local child process) or SSE (remote HTTP) using @modelcontextprotocol/sdk.
- Tools that require confirmation can be specified per server requires_confirmation; confirmations can be bypassed with --no-confirmations (see Safety and confirmations).

Minimal example:

```jsonc
{
  "systemPrompt": "You are an AI assistant.",
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "api_key": "your-api-key",
    "temperature": 0
  },
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "..." },
      "requires_confirmation": ["search"]
    }
  }
}
```

### SSE transport example

To connect to a remote MCP server over Server-Sent Events (SSE), configure a server with an sse.url (optionally headers). When sse.url is present, it takes precedence over command/args.

```jsonc
{
  "mcpServers": {
    "remote-docs": {
      // Connect over SSE (no local process spawned)
      "sse": {
        "url": "https://example.com/mcp/sse",
        "headers": {
          "Authorization": "Bearer YOUR_TOKEN"
        }
      },
      // Optional: still allowed to include excludes or requires_confirmation
      "exclude_tools": ["dangerous_tool"],
      "requires_confirmation": ["update_record"]
    }
  }
}
```

For local child-process servers (stdio), keep using command/args:

```jsonc
{
  "mcpServers": {
    "local-brave": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "..." }
    }
  }
}
```

## Agents

Agents define which MCP servers and specific tools are available to the model for a given run. They can also set a per-agent system prompt and an allowlist of agents they are permitted to call via call_agent.

Where agents are loaded from (priority order, later merges don’t override earlier of the same name):
1) Inline config (config.agents)
2) Project directory: ./agents
3) Global: ~/.llm/agents

Loading/merge logic: [TypeScript.loadAgents()](src/lib/agents.ts:62)

List agents:
```bash
node dist/bin/llm.js --list-agents
```

Run with an agent:
```bash
node dist/bin/llm.js --agent researcher "Find sources on topic X"
```

Example agent file (JSONC), e.g. ./agents/researcher.jsonc:
```jsonc
{
  // Human-friendly description
  "description": "Research assistant with web search capabilities.",
  // Optional custom system prompt for this agent
  "systemPrompt": "You are a focused research assistant.",
  // Server whitelisting and per-server tool includes/excludes
  "servers": {
    "brave-search": {
      "include_tools": ["search", "news_search"]
    }
  },
  // Which other agents this one may call via the call_agent tool
  "allowedAgents": ["gmail_assistant", "reclaim"]
}
```

The orchestrator (no --agent) has no tools. Tools are only exposed when an agent scope is active, enforced in [TypeScript.setupTools()](src/lib/mcp.ts:148).

## Usage

Help (with examples) is embedded in the CLI:
- Main program: [src/bin/llm.ts](src/bin/llm.ts)
- Action delegates to: [TypeScript.chatWithOpenAI()](src/lib/llm-core.ts:89)

Common commands:

```bash
# List prompt templates
node dist/bin/llm.js --list-prompts

# List agents discovered from config and agents directories
node dist/bin/llm.js --list-agents

# List MCP tools across enabled servers (for inspection)
# Note: This does not imply those tools are usable without an agent scope
node dist/bin/llm.js --list-tools

# Ask a question (no tools; orchestrator-only)
node dist/bin/llm.js "What is the capital of France?"

# Use an agent so the model can access its whitelisted MCP tools
node dist/bin/llm.js --agent researcher "Find recent news on quantum dot displays"

# Use a prompt template
# Syntax: p <name> <template-args...>
node dist/bin/llm.js p yt https://www.youtube.com/watch?v=NExtKbS1Ljc
```

Important flags:
- --agent <name>: activate per-agent tools and behavior
- --model <model>: override model from config
- --no-confirmations: bypass requires_confirmation prompts
- --no-tools: force-disable tools (even under an agent)
- --no-intermediates: only print the final assistant message
- --text-only: print raw text without additional formatting
- --force-refresh: reserved for future caching behavior
- --show-memories: reserved (not implemented)

## Prompt templates

Templates are defined in: [src/prompts.ts](src/prompts.ts)

List them:
```bash
node dist/bin/llm.js --list-prompts
```

Invoke a template:
```bash
# p <name> ...
node dist/bin/llm.js p review
```

Two notable templates:
- review: code review flow oriented to git status/diff narratives
- email_labeling_orchestrator: Orchestrates a Gmail labeling workflow across multiple agents via call_agent. See its definition in [src/prompts.ts](src/prompts.ts).

## Safety and confirmations

- Some server tools can be marked as requiring confirmation (requires_confirmation in your config). These names are gathered at load time via [TypeScript.loadConfig()](src/lib/config.ts:29) and enforced in [TypeScript.chatWithOpenAI()](src/lib/llm-core.ts:89).
- Bypass confirmations by passing --no-confirmations if you trust your current agent setup.

## Architecture

High-level flow:
1) CLI parses args and loads config: [TypeScript.loadConfig()](src/lib/config.ts:29)
2) Agents are resolved/merged: [TypeScript.loadAgents()](src/lib/agents.ts:62)
3) Chat session begins in [TypeScript.chatWithOpenAI()](src/lib/llm-core.ts:89)
4) If an agent is active, MCP servers are connected and tools are discovered/scoped: [TypeScript.setupTools()](src/lib/mcp.ts:148)
5) The model can call MCP tools and the virtual call_agent to delegate to other agents.
6) All connected servers are closed on completion.

Design notes:
- CLI: commander, consola, chalk
- OpenAI: official openai SDK
- MCP: @modelcontextprotocol/sdk (stdio and SSE transports)
- Config: comment-json for commented JSON compatibility
- Prompts: simple template substitution (see [src/prompts.ts](src/prompts.ts))

## Development

- TypeScript config: [tsconfig.json](tsconfig.json)
- Build: npm run build
- Entry: [src/bin/llm.ts](src/bin/llm.ts)
- Types: [src/types.ts](src/types.ts)
- Prompts: [src/prompts.ts](src/prompts.ts)
- LLM core: [TypeScript.chatWithOpenAI()](src/lib/llm-core.ts:89)

## License

MIT