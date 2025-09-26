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
- Custom OpenAI base URL can be set via config llm.base_url (e.g. "https://api.openai.example.com") or env OPENAI_BASE_URL / LLM_BASE_URL. If omitted/null, the SDK default is used.
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
    // Optional: override the OpenAI API base URL (or use env OPENAI_BASE_URL / LLM_BASE_URL)
    "base_url": null,
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

### Agent visibility allowlist (CLI)

You can allow the main orchestrator access to only a subset of agents (mostly the root agents are needed, they can delegate to the sub agents)

- --agents "name1,name2"
- --agents-text-file <path> (one agent name per line)

Examples:
```bash
# Restrict visibility/delegation to two agents
node dist/bin/llm.js --agents "researcher,writer" "Summarize today's news"

# Load allowlist from a text file (one name per line)
node dist/bin/llm.js --agents-text-file allowed-agents.txt "Draft a blog post"

# Combine with an active agent scope
node dist/bin/llm.js --agent researcher --agents "writer,reviewer" "Plan an article"
```

Notes:
- Unknown agent names are ignored with a warning.
- The allowlist constrains the enum for the virtual call_agent tool and the set of visible agents. It does not replace --agent; you still set the active agent scope with --agent as usual.
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

# Inspect configured MCP servers (does not connect or use them)
node dist/bin/llm.js --list-mcp-servers

# List MCP tools across enabled servers (for inspection; connects read-only)
# Note: This does not imply those tools are usable without an agent scope
node dist/bin/llm.js --list-tools
# Alias with explicit server grouping label
node dist/bin/llm.js --list-tools-by-server

# Ask a question (no tools; orchestrator-only)
node dist/bin/llm.js "What is the capital of France?"

# Use an agent so the model can access its whitelisted MCP tools
node dist/bin/llm.js --agent researcher "Find recent news on quantum dot displays"

# Use a prompt template
# Syntax: p <name> <template-args...>
node dist/bin/llm.js p yt https://www.youtube.com/watch?v=NExtKbS1Ljc
```

### Agent Generator (create/edit agents safely)

The CLI includes a lightweight "agent generator" to manage agent files without granting tool execution. It can:
- Read agents from the agents directories and inline config
- Create a new agent JSONC file
- Update an existing agent's description/prompt and per-server include/exclude lists
- List configured MCP servers without connecting

Flags:

```bash
# List merged agents from inline config + directories
node dist/bin/llm.js --list-agents-merged

# Create a new agent
node dist/bin/llm.js --create-agent researcher \
  --agent-desc "Research assistant" \
  --agent-prompt "You are a focused research assistant." \
  --agent-servers-include "brave-search=search,news_search" \
  --agent-servers-exclude "mcp-server-commands=run_command,run_script"

# Update an existing agent (only provided fields are changed)
node dist/bin/llm.js --update-agent researcher \
  --agent-desc "Web research assistant" \
  --agent-servers-include "brave-search=search"
```

Server list spec format:
- --agent-servers-include "serverA=tool1,tool2;serverB=toolX"
- --agent-servers-exclude "serverA=toolY;serverB=toolZ,toolW"

Validation and safety behavior:
- If you reference servers not present in mcp-server-config.json, the command fails with a console message instructing you to install/configure those servers first.
- Agent files are created under, in priority order: app.agentsDir, ./agents, or ~/.llm/agents (directories are created if missing).
- No MCP tools are executed by these commands; listing tools uses read-only capability discovery.

### AI Agent Generator (use-case driven, creates root orchestrator)

Given a natural-language use case, the CLI can architect a multi-agent setup automatically:
- Connects to each enabled MCP server and lists tools (read-only)
- Uses examples from your existing agents as guidance
- Proposes a set of specialized agents with minimal tool surfaces
- Always creates a root orchestrator agent that embeds the full use case in its systemPrompt and delegates to the specialized agents
- Validates that referenced servers and tools exist before writing

Commands:

```bash
# Dry-run (plan only; prints agent names and target directory)
node dist/bin/llm.js --generate-from-use-case "Inbox triage with Gmail, summarize top news from RSS, and create calendar tasks" --dry-run

# Generate and write JSONC agent files
node dist/bin/llm.js --generate-from-use-case "Inbox triage with Gmail, summarize top news from RSS, and create calendar tasks"

# Overwrite conflicting filenames if needed
node dist/bin/llm.js --generate-from-use-case "..." --force

# Append generated agent names to an allowlist file
node dist/bin/llm.js --generate-from-use-case "..." --add-generated-agents-to allowed-agents.txt
```

Post-generation allowlist update:
- When --add-generated-agents-to is provided, all generated agent names (including the root orchestrator) are appended to the given file, one per line.
- The file is created if missing, names are de-duplicated, and trailing newline ensured.
- Blank lines are ignored; order is preserved where possible.
- In --dry-run mode, the list file is not modified.

Generation details:
- The root agent contains:
  - description: Root orchestrator
  - systemPrompt: Full use-case text plus orchestration guidance
  - servers: none (it delegates; no direct tool use)
  - allowedAgents: all generated specialized agents
- Specialized agents each include only the tools they need per server via include_tools/exclude_tools.
- If any proposed server/tool is unavailable, generation fails with a clear message (no files written). See implementation: [TypeScript.generateAgentsFromUseCase()](src/lib/agentgen.ts:335), discovery via [TypeScript.discoverServerTools()](src/lib/agentgen.ts:250).

Append generated agent names to a list file:
- Use --add-generated-agents-to <path> together with --generate-from-use-case to update a plain-text allowlist.
- Behavior: creates parent directories if needed; ignores blank lines; deduplicates names; ensures trailing newline.
- The list can be used later with --agents-text-file to constrain visible agents during a run.

Important flags:
- --agent <name>: activate per-agent tools and behavior
- --agents <names>: comma-separated allowlist restricting which agents are visible/targetable for delegation during this run
- --agents-text-file <path>: path to a text file with one agent name per line to use as the allowlist
- --add-generated-agents-to <path>: when used with --generate-from-use-case, append generated agent names to <path> (one per line)
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