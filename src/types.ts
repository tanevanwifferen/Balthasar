export type LLMConfig = {
  model: string;
  provider: string;
  api_key?: string;
  temperature: number;
  base_url?: string | null;
};

/**
 * Global MCP server configuration (base capabilities).
 * Per-agent scoping can further restrict tools via include lists.
 */
export type ServerConfig = {
  /**
   * stdio transport (default) — start a local MCP server as a child process.
   * If provided, this transport will be used unless an sse.url is also provided (sse takes precedence).
   */
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  /**
   * Enable/disable this server globally.
   */
  enabled?: boolean;

  /**
   * SSE transport — connect to a remote MCP server over HTTP(S) Server-Sent Events.
   * When sse.url is provided, the client will connect using SSE instead of spawning a process.
   */
  sse?: {
    /**
     * The full HTTP(S) URL of the MCP server SSE endpoint.
     * Example: https://your-host.example.com/mcp/sse
     */
    url: string;
    /**
     * Optional HTTP headers to include (e.g., Authorization).
     */
    headers?: Record<string, string>;
  };

  /**
   * Globally exclude tools exposed by this server (applies to all agents).
   */
  exclude_tools?: string[];

  /**
   * Tools that require a confirmation step before execution.
   */
  requires_confirmation?: string[];

  /**
   * Optional global include list for this server. If provided, only tools
   * in this list will be exposed (before agent-level filtering).
   */
  include_tools?: string[];
};

/**
 * Agent-level server policy. Agents can whitelist server tools.
 */
export type AgentServerPolicy = {
  /**
   * If provided, only these tools from the server are available to the agent.
   */
  include_tools?: string[];
  /**
   * Optional additional excludes for this agent (applied after include_tools).
   */
  exclude_tools?: string[];
};

/**
 * Agent configuration loaded from agents directory or inline.
 */
export type AgentConfig = {
  /**
   * Human-friendly description for UI/UX.
   */
  description?: string;

  /**
   * Optional per-agent system prompt used when this agent is the active scope.
   * If empty or omitted, falls back to app.systemPrompt or a default.
   */
  systemPrompt?: string;

  /**
   * Map of serverName -> per-server tool policy for this agent.
   * If empty/omitted, the agent has no access to any servers.
   */
  servers?: Record<string, AgentServerPolicy>;

  /**
   * Other agents this agent is allowed to call using the virtual "call_agent" tool.
   * If omitted, no agent-to-agent calls are permitted.
   */
  allowedAgents?: string[];
};

/**
 * App configuration file.
 * Optionally points to a directory containing agent JSON/JSONC files.
 */
export type AppConfig = {
  systemPrompt: string;
  llm: LLMConfig;
  mcpServers: Record<string, ServerConfig>;

  /**
   * Optional directory path containing agent configs (JSON/JSONC files).
   * Defaults resolved by loader (e.g. ./agents or ~/.llm/agents).
   */
  agentsDir?: string;

  /**
   * Optional inline agent definitions keyed by agent name.
   * If both inline and directory agents exist with the same name,
   * directory definitions take precedence.
   */
  agents?: Record<string, AgentConfig>;
};

export type LoadedConfig = AppConfig & {
  /**
   * Flattened list of tools across servers that require confirmation.
   */
  tools_requires_confirmation: string[];
};

export type McpServerConfig = {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  excludeTools: string[];
};
