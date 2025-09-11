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
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;

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
