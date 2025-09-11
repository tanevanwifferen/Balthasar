# MCP Client CLI (TypeScript)

A modern, TypeScript-based CLI to:
- Connect to MCP-compatible servers via stdio using the official SDK
- Chat with OpenAI models
- List available MCP tools
- Use prompt templates

Focus: Leverage robust libraries instead of reinventing implementations, while keeping a clean, maintainable structure.

## Install

```bash
npm install
npm run build
```

This provides the llm CLI at dist/bin/llm.js. When published to npm, it will be available globally as the llm command via the bin entry.

## Configure

Create a config file at one of:
- ./mcp-server-config.json
- ~/.llm/config.json

See mcp-server-config-example.json for a reference format. Example:

```jsonc
{
  "systemPrompt": "You are an AI assistant...",
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "api_key": "your-api-key-here",
    "temperature": 0
  },
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "your-brave-api-key-here"
      }
    }
  }
}
```

Notes:
- OpenAI API key is read from config llm.api_key or env OPENAI_API_KEY / LLM_API_KEY.
- MCP servers are launched via stdio using @modelcontextprotocol/sdk.

## Usage

```bash
# List prompts
node dist/bin/llm.js --list-prompts

# List tools discovered from MCP stdio servers
node dist/bin/llm.js --list-tools

# Ask a simple question with OpenAI
node dist/bin/llm.js "What is the capital of France?"

# Use a prompt template
node dist/bin/llm.js p yt https://www.youtube.com/watch?v=NExtKbS1Ljc
```

Planned next:
- Streamed output with confirmations for tool calls
- Memory store (lowdb) to persist user memories
- Continue conversation threads
- Integrate MCP tool-calls into OpenAI structured tool calling

## Design

- CLI: commander, consola, chalk
- OpenAI: official openai SDK
- MCP: @modelcontextprotocol/sdk (stdio transport)
- Config: comment-json for commented JSON compatibility
- Prompts: simple template substitution (src/prompts.ts)

## Development

- TypeScript config in tsconfig.json
- Build with npm run build
- Code entry: src/bin/llm.ts
- Types: src/types.ts
- Prompts: src/prompts.ts

## Migration status

- Python CLI behavior analyzed and core parity planned
- TypeScript CLI scaffolded with working list-tools, list-prompts, and OpenAI chat
- Configuration loader compatible with original file layout
- Next steps: memories, confirmations, streaming, tool-calls

License: MIT