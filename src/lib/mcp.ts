import consola from "consola";
import { spawn } from "node:child_process";
import type { AppConfig, ServerConfig, AgentConfig } from "../types.js";

// MCP SDK (stdio)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Public types
export type ConnectedServer = {
  name: string;
  client: Client;
  close: () => Promise<void>;
};

export type ToolRegistryEntry = {
  name: string;
  description?: string;
  parameters?: any;
  server: ConnectedServer;
};

// Connect a single MCP server over either stdio (child process) or SSE (HTTP)
export async function connectServer(
  name: string,
  conf: ServerConfig
): Promise<ConnectedServer> {
  const sseUrl = conf?.sse?.url;

  let transport: SSEClientTransport | StdioClientTransport;
  if (sseUrl && typeof sseUrl === "string") {
    // SSE transport: connect to remote MCP server via HTTP(S) Server-Sent Events
    const urlObj = new URL(sseUrl);
    const headers = conf?.sse?.headers ?? {};
    transport = new SSEClientTransport(urlObj, {
      fetch: (url, init) => {
        return fetch(url, {
          ...init,
          headers: {
            ...init?.headers,
            ...headers,
          },
        });
      },
    });
  } else {
    // stdio transport: spawn a local MCP server process
    const cmd = conf?.command;
    const args = conf?.args ?? [];
    if (!cmd || typeof cmd !== "string") {
      throw new Error(
        `Invalid MCP server config for "${name}": either provide sse.url or a non-empty "command"`
      );
    }
    const env = { ...process.env, ...(conf.env ?? {}) };
    transport = new StdioClientTransport({
      command: cmd,
      args,
      env,
    } as any);
  }

  const client = new Client(
    {
      name: "mcp-client-cli",
      version: "0.1.0",
    },
    {
      capabilities: {
        prompts: {},
        tools: {},
        resources: {},
      },
    }
  );

  // Establish MCP client connection with detailed error reporting
  try {
    await client.connect(transport);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const stack = err?.stack ?? "";
    // Promote to warn so it shows up by default
    consola.warn(`connect("${name}") failed: ${msg}`);
    if (stack) consola.warn(stack);
    // Re-throw so callers can surface a concise failure message too
    throw err;
  }

  const close = async () => {
    try {
      await client.close();
    } catch {
      // ignore
    }
  };

  return { name, client, close };
}

// List tools across enabled servers (for CLI flag)
export async function listAllTools(
  app: AppConfig,
  opts: { forceRefresh?: boolean }
) {
  const servers = Object.entries(app.mcpServers).filter(
    ([, s]) => s.enabled !== false
  );
  if (!servers.length) {
    consola.info("No enabled MCP servers in config");
    return;
  }
  console.log("\n\x1b[1mAvailable LLM Tools\x1b[0m\n");

  const connected: ConnectedServer[] = [];
  try {
    for (const [name, sconf] of servers) {
      const hasSse = !!(sconf as any)?.sse?.url;
      const hasCmd = !!(sconf?.command && typeof sconf.command === "string");
      if (!hasSse && !hasCmd) {
        consola.warn(
          `Skipping server "${name}": provide either sse.url or a valid "command"`
        );
        continue;
      }

      let s: ConnectedServer | undefined;
      try {
        s = await connectServer(name, sconf);
        connected.push(s);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        consola.warn(`Failed to connect to "${name}": ${msg}`);
        if (err?.stack) {
          consola.debug(err.stack);
        }
        continue;
      }

      let tools: Awaited<ReturnType<Client["listTools"]>>;
      try {
        tools = await s.client.listTools();
      } catch (e) {
        const msg =
          e && typeof e === "object" && "message" in (e as any)
            ? (e as any).message
            : String(e);
        consola.warn(`Server ${name}: cannot list tools (${msg})`);
        continue;
      }
      const exclude = new Set(sconf.exclude_tools ?? []);
      const filtered = (tools?.tools ?? []).filter(
        (t: any) => !exclude.has(t.name)
      );
      if (!filtered.length) {
        console.log(`${name}: no tools`);
        continue;
      }
      console.log(`[${name}]`);
      for (const t of filtered) {
        console.log(`- ${t.name}${t.description ? `: ${t.description}` : ""}`);
      }
    }
  } finally {
    await Promise.allSettled(connected.map((c) => c.close()));
  }
  console.log("");
}

// Build registry for OpenAI function tools and keep servers connected
export async function setupTools(
  app: AppConfig,
  opts: { noTools?: boolean },
  agentScope?: { agentName?: string; agent?: AgentConfig }
): Promise<{
  connected: ConnectedServer[];
  registry: Map<string, ToolRegistryEntry>;
  openAITools: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: any };
  }>;
}> {
  if (opts.noTools) {
    return { connected: [], registry: new Map(), openAITools: [] };
  }

  // Enforce: The default (no agent scope) cannot execute tools.
  // Only when an agent scope is provided do we expose any tools.
  if (!agentScope?.agent) {
    return { connected: [], registry: new Map(), openAITools: [] };
  }

  // Build list of servers respecting "enabled" and per-agent allowlist
  const servers = Object.entries(app.mcpServers).filter(([name, s]) => {
    if (s.enabled === false) return false;
    if (agentScope?.agent?.servers) {
      return Object.prototype.hasOwnProperty.call(
        agentScope.agent.servers,
        name
      );
    }
    // No agent scope is handled earlier (returns no tools).
    return false;
  });
  const connected: ConnectedServer[] = [];
  const registry = new Map<string, ToolRegistryEntry>();

  for (const [name, sconf] of servers) {
    const hasSse = !!(sconf as any)?.sse?.url;
    const hasCmd = !!(sconf?.command && typeof sconf.command === "string");
    if (!hasSse && !hasCmd) continue;
    let s: ConnectedServer | undefined;
    try {
      s = await connectServer(name, sconf);
      connected.push(s);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      consola.warn(`Failed to connect to "${name}": ${msg}`);
      if (err?.stack) {
        consola.debug(err.stack);
      }
      continue;
    }

    let tools: Awaited<ReturnType<Client["listTools"]>>;
    try {
      tools = await s.client.listTools();
    } catch (e) {
      const msg =
        e && typeof e === "object" && "message" in (e as any)
          ? (e as any).message
          : String(e);
      consola.warn(`Server ${name}: cannot list tools (${msg})`);
      continue;
    }
    // Global include/exclude (server-level)
    const globalExclude = new Set(sconf.exclude_tools ?? []);
    const globalInclude = new Set(
      (sconf as any) && (sconf as any).include_tools
        ? (sconf as any).include_tools
        : []
    );

    // Agent-level policy for this server (if any)
    const policy = agentScope?.agent?.servers?.[name];
    const agentInclude = new Set(policy?.include_tools ?? []);
    const agentExclude = new Set(policy?.exclude_tools ?? []);

    // Compose filter predicate:
    // - If any include list exists (global or agent), the tool must appear in ALL provided include lists.
    // - Any exclude list (global or agent) will remove the tool.
    const filtered = (tools?.tools ?? []).filter((t: any) => {
      const toolName = t.name as string;

      // Exclusions take precedence
      if (globalExclude.has(toolName)) return false;
      if (agentExclude.has(toolName)) return false;

      // Includes: if defined, must be present
      if (globalInclude.size > 0 && !globalInclude.has(toolName)) return false;
      if (agentInclude.size > 0 && !agentInclude.has(toolName)) return false;

      return true;
    });
    for (const t of filtered) {
      // MCP input schema typically under inputSchema
      const parameters = t.inputSchema ?? t.parameters ?? undefined;
      registry.set(t.name, {
        name: t.name,
        description: t.description,
        parameters,
        server: s,
      });
    }
  }

  const openAITools = Array.from(registry.values()).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  return { connected, registry, openAITools };
}
