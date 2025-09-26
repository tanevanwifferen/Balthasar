import consola from "consola";
import chalk from "chalk";
import prompts from "prompts";
import { OpenAI } from "openai";
import { promptTemplates } from "../prompts.js";
import type { CLIOptions } from "./config.js";
import { setupTools } from "./mcp.js";
import { normalizeMcpContentToString, safeParseJSON } from "./util.js";
import { loadAgents } from "./agents.js";
import type { AgentConfig } from "../types.js";

// -------------------------
// Prompts listing
// -------------------------
export async function listPrompts() {
  const rows = Object.entries(promptTemplates).map(([name, tpl]) => {
    const args = Array.from(tpl.matchAll(/\{(\w+)\}/g)).map((m) => m[1]);
    return { name, args, tpl };
  });
  if (!rows.length) {
    consola.info("No prompts found");
    return;
  }
  const w = 80;
  console.log(chalk.bold("\nAvailable Prompt Templates\n"));
  for (const r of rows) {
    console.log(
      `${chalk.cyan(r.name)}  args: ${chalk.gray(r.args.join(", ") || "-")}`
    );
    const tplWrapped = wrap(r.tpl, w - 2)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n");
    console.log(tplWrapped + "\n");
  }
}

function wrap(s: string, width: number) {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}

// Normalize assistant message content which may be string or array of content parts
function normalizeAssistantContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part?.text === "string"
          ? part.text
          : typeof part === "string"
            ? part
            : ""
      )
      .join("");
  }
  return "";
}

// -------------------------
// OpenAI client
// -------------------------
export function makeOpenAI(
  app: {
    llm: {
      api_key?: string;
      model?: string;
      base_url?: string | null;
      temperature?: number;
    };
  },
  overrideModel?: string
) {
  const apiKey =
    app.llm.api_key || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OpenAI API key. Set llm.api_key in config or OPENAI_API_KEY env."
    );
  }
  const model = overrideModel || app.llm.model || "gpt-4o-mini";
  const baseURL =
    app.llm.base_url ||
    process.env.OPENAI_BASE_URL ||
    process.env.LLM_BASE_URL ||
    undefined;

  const client = new OpenAI({
    apiKey,
    baseURL,
  });

  return { client, model };
}

// -------------------------
// Chat with tool chaining
// -------------------------
export async function chatWithOpenAI(
  app: {
    systemPrompt?: string;
    llm: { temperature?: number };
    tools_requires_confirmation?: string[];
    mcpServers: Record<string, unknown>;
  },
  query: string,
  opts: CLIOptions,
  depth = 0
): Promise<string> {
  const isTopLevel = depth === 0;
  const quiet = !!opts.noIntermediates;
  if (isTopLevel && !quiet) consola.info("input:", query);
  const { client, model } = makeOpenAI(app as any, opts.model);

  // Determine agent scope (tools whitelist per server and allowed sub-agents)
  const { agents } = loadAgents(app as any);
  const currentAgentName = opts.agent || undefined;
  const currentAgent: AgentConfig | undefined = currentAgentName
    ? agents[currentAgentName]
    : undefined;
  if (currentAgentName && !currentAgent) {
    if (isTopLevel && !quiet) {
      consola.warn(
        `Agent '${currentAgentName}' not found. Proceeding without agent scoping.`
      );
    }
  }

  // Compute system prompt: prefer agent-specific when available, else app/system default
  const system =
    currentAgent &&
    typeof (currentAgent as any).systemPrompt === "string" &&
    (currentAgent as any).systemPrompt.trim()
      ? (currentAgent as any).systemPrompt
      : app.systemPrompt || "You are a helpful assistant.";

  // Compute the set of agent names visible/allowable to the model for delegation
  const allAgentNames = Object.keys(agents);
  let visibleAgentNames = allAgentNames;
  // Agent-level allowlist
  if (
    currentAgent &&
    Array.isArray(currentAgent.allowedAgents) &&
    currentAgent.allowedAgents.length
  ) {
    visibleAgentNames = currentAgent.allowedAgents.filter((n) => n in agents);
  } else {
    // CLI allowlist (--agents/--agents-text-file)
    if (Array.isArray(opts.agents) && opts.agents.length) {
      const allow = new Set(opts.agents);
      const unknown = opts.agents.filter((n) => !(n in agents));
      if (unknown.length && isTopLevel && !quiet) {
        consola.warn(
          `Ignoring unknown agent names from --agents: ${unknown.join(", ")}`
        );
      }
      visibleAgentNames = visibleAgentNames.filter((n) => allow.has(n));
    }
  }

  // system prompt computed above

  // Prepare tools (connect MCP servers, map tools) with optional agent scope
  const { connected, registry, openAITools } = await setupTools(
    app as any,
    { noTools: opts.noTools },
    currentAgent
      ? { agentName: currentAgentName, agent: currentAgent }
      : undefined
  );

  // Inject a virtual "call_agent" tool that can delegate to a named agent
  // Schema: { query: string; target_agent?: string }
  // Only include an enum when there are visible agents; some providers reject empty enums.
  const targetAgentEnumProp = visibleAgentNames.length
    ? ({ enum: visibleAgentNames } as any)
    : {};
  const virtualCallAgentTool = {
    type: "function" as const,
    function: {
      name: "call_agent",
      description:
        "Delegate by calling another agent with the provided query. Respects per-agent allowedAgents and tool whitelists.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The query to pass to the delegated agent.",
          },
          target_agent: {
            type: "string",
            description: `Name of the target agent. If omitted, will reuse the current agent scope if any; otherwise runs unscoped. Allowed: ${visibleAgentNames.join(", ") || "(none)"}`,
            ...targetAgentEnumProp,
          },
        },
        required: ["query"],
      },
    },
  };

  // Combine MCP-discovered tools with the virtual tool (unless tools are disabled)
  const allTools = opts.noTools ? [] : [...openAITools, virtualCallAgentTool];

  // Augment the system prompt with agent context so the model knows what's available
  const agentContext = [
    `Agent context:`,
    `- Current agent scope: ${currentAgent && currentAgentName ? currentAgentName : "none"}`,
    `- Available agents for delegation: ${visibleAgentNames.join(", ") || "(none)"}`,
    `Use the call_agent tool to delegate to one of the available agents when helpful.`,
  ].join("\n");

  const updatedSystem =
    "Do not ask for permission, and don't ask child agents to ask for permission. This runs headless. You're supposed to make your own decisions.";
  const systemWithAgents = [system, updatedSystem, agentContext].join("\n\n");
  const scopeLabel = currentAgentName
    ? `[agent:${currentAgentName}]`
    : `[orchestrator]`;

  // Thread date banner (once, at thread start; never updated during loop)
  const now = new Date();
  const timeZone =
    process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateBanner = `Thread start date: ${dateFormatter.format(now)} (${timeZone})`;

  const messages: any[] = [
    { role: "system", content: dateBanner },
    { role: "system", content: systemWithAgents },
    { role: "user", content: query },
  ];
  // Track the last assistant message received from the model (for proper returns after tool runs)
  let lastAssistantText = "";

  // Fast-path: if there are no tools at all, run a single-turn completion and return.
  // Fast-path: no tools available at all — print a single final once (regardless of intermediates setting)
  if (allTools.length === 0) {
    const singlePayload: any = {
      model,
      messages,
      reasoning_effort: "low",
      temperature: app.llm.temperature ?? 0,
    };
    let response;
    try {
      response = await client.chat.completions.create(singlePayload);
    } catch (e: any) {
      const emsg =
        (e && typeof e === "object" && "message" in e
          ? e.message
          : String(e)) || "Unknown error from chat.completions.create";
      consola.error(emsg);
      return emsg;
    }
    const choice = response.choices?.[0];
    const assistantText =
      (choice?.message
        ? normalizeAssistantContent(choice.message.content)
        : "") || "";
    if (assistantText && isTopLevel) {
      const decorated = `${scopeLabel} ${assistantText}`;
      console.log(opts.textOnly ? decorated : "\n" + decorated + "\n");
    }
    // Return the raw assistant text so callers (including parent agents) receive the exact last model message
    return assistantText;
  }

  const requiresConfirmation = new Set(app.tools_requires_confirmation || []);
  const temperature = app.llm.temperature ?? 0;

  try {
    // Limit to avoid infinite loops in pathological cases
    for (let step = 0; step < 32; step++) {
      // Build payload conditionally: tool_choice is only valid if tools are present
      const payload: any = {
        model,
        messages,
        temperature,
        reasoning_effort: "low",
      };
      if (allTools.length) {
        payload.tools = allTools as any;
        payload.tool_choice = "auto" as any;
      }
      let response;
      try {
        response = await client.chat.completions.create(payload);
      } catch (e: any) {
        // If the provider rejects due to missing/invalid tools, surface and terminate loop
        const emsg =
          (e && typeof e === "object" && "message" in e
            ? e.message
            : String(e)) || "Unknown error from chat.completions.create";
        consola.error(emsg);
        return emsg;
      }

      const choice = response.choices?.[0];
      const msg = choice?.message;
      const finish = choice?.finish_reason as string | undefined;

      if (!msg) {
        if (isTopLevel && !quiet) consola.warn("No message from model");
        return "No message from model";
      }

      // Compute assistant output (track last assistant text so parent gets the latest sub-agent message)
      const assistantText = normalizeAssistantContent(msg.content);
      if (assistantText) {
        lastAssistantText = assistantText;
      }

      // Add assistant message to the transcript
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls, // preserve tool calls for context
      });

      // Determine if this is a final turn (no tool calls or model indicated stop)
      const toolCalls = msg.tool_calls ?? [];
      const isFinalTurn = !toolCalls.length || finish === "stop";

      // Printing policy:
      // - Only print at top-level (depth === 0). Nested agent calls never print directly.
      // - With --no-intermediates (quiet): print only the final turn once.
      // - Without --no-intermediates: print each intermediate turn, but do not reprint the final to avoid duplication.
      if (assistantText && isTopLevel) {
        if (isFinalTurn) {
          if (quiet) {
            const decorated = `${scopeLabel} ${assistantText}`;
            console.log(opts.textOnly ? decorated : "\n" + decorated + "\n");
          }
        } else if (!quiet) {
          const out = `${scopeLabel} ${assistantText}`;
          console.log(opts.textOnly ? out : "\n" + out + "\n");
        }
      }

      if (isFinalTurn) {
        // Return the raw last model message (not decorated) so parent agent gets the exact content
        return assistantText || lastAssistantText || "";
      }

      // Execute each requested tool call, append tool results, then loop
      for (const tc of toolCalls) {
        const toolName = tc?.function?.name;
        const rawArgs = tc?.function?.arguments ?? "";
        const callId = tc?.id;

        if (!toolName) {
          // Append an error tool message so the model can recover
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: `Tool call missing function name`,
          });
          continue;
        }
        // Handle virtual tool "call_agent" by recursively invoking this function with per-agent scoping.
        if (toolName === "call_agent") {
          // Depth guard to avoid runaway recursion
          if (depth >= 5) {
            messages.push({
              role: "tool",
              tool_call_id: callId,
              content: `call_agent refused: maximum recursion depth reached`,
            });
            continue;
          }

          const args =
            typeof rawArgs === "string" ? safeParseJSON(rawArgs) : rawArgs;
          const subQuery =
            (args && typeof args.query === "string" && args.query.trim()) || "";
          const targetAgent: string | undefined =
            args &&
            typeof args.target_agent === "string" &&
            args.target_agent.trim()
              ? args.target_agent.trim()
              : undefined;

          if (!subQuery) {
            messages.push({
              role: "tool",
              tool_call_id: callId,
              content: `call_agent requires a non-empty "query" string`,
            });
            continue;
          }

          // Resolve target agent name and enforce allowedAgents from current agent (if any)
          const targetName = targetAgent ?? currentAgentName;
          if (targetName) {
            const { agents: mergedAgents } = loadAgents(app as any);
            const target = mergedAgents[targetName];
            if (!target) {
              messages.push({
                role: "tool",
                tool_call_id: callId,
                content: `call_agent failed: unknown agent '${targetName}'`,
              });
              continue;
            }
            // If we are currently in an agent scope, enforce allowedAgents
            if (currentAgent && Array.isArray(currentAgent.allowedAgents)) {
              const allowed = new Set(currentAgent.allowedAgents);
              if (!allowed.has(targetName)) {
                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  content: `call_agent refused: agent '${currentAgentName}' is not allowed to call '${targetName}'`,
                });
                continue;
              }
            }
            // Also enforce CLI allowlist (--agents/--agents-text-file), if provided
            else if (Array.isArray(opts.agents) && opts.agents.length) {
              const cliAllow = new Set(opts.agents);
              if (!cliAllow.has(targetName)) {
                messages.push({
                  role: "tool",
                  tool_call_id: callId,
                  content: `call_agent refused: target agent '${targetName}' not in CLI allowlist (--agents)`,
                });
                continue;
              }
            }

            try {
              // Re-enter chatWithOpenAI with the same config and flags but switching opts.agent to the target
              const nextOpts: CLIOptions = { ...opts, agent: targetName };
              const result = await chatWithOpenAI(
                app as any,
                subQuery,
                nextOpts,
                depth + 1
              );
              messages.push({
                role: "tool",
                tool_call_id: callId,
                content: `call_agent completed: ${targetName}\n${result}`,
              });
            } catch (e: any) {
              const emsg = e?.message ?? String(e);
              messages.push({
                role: "tool",
                tool_call_id: callId,
                content: `call_agent failed (${targetName}): ${emsg}`,
              });
            }
          } else {
            // No target agent: run unscoped (legacy behavior)
            try {
              let out = await chatWithOpenAI(
                app as any,
                subQuery,
                opts,
                depth + 1
              );
              messages.push({
                role: "tool",
                tool_call_id: callId,
                content: `call_agent completed (unscoped), result:\n${out}`,
              });
            } catch (e: any) {
              const emsg = e?.message ?? String(e);
              messages.push({
                role: "tool",
                tool_call_id: callId,
                content: `call_agent failed (unscoped): ${emsg}`,
              });
            }
          }
          continue;
        }

        const entry = registry.get(toolName);
        if (!entry) {
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: `Unknown tool: ${toolName}`,
          });
          continue;
        }

        // Confirmation if required
        if (requiresConfirmation.has(toolName) && !opts.noConfirmations) {
          const ans = await (prompts as any)({
            type: "confirm",
            name: "ok",
            message: `Run tool ${toolName}?`,
            initial: false,
          });
          if (!ans?.ok) {
            messages.push({
              role: "tool",
              tool_call_id: callId,
              content: `User declined to run tool ${toolName}`,
            });
            continue;
          }
        }

        // Parse arguments
        const args =
          typeof rawArgs === "string" ? safeParseJSON(rawArgs) : rawArgs;

        // Call the MCP tool
        try {
          const result = await (entry.server.client as any).callTool({
            name: toolName,
            arguments: args ?? {},
          });
          const rendered = normalizeMcpContentToString(result);

          if (isTopLevel && !quiet) {
            // Show tool result chunks as they arrive (non-streamed here)
            console.log(
              opts.textOnly
                ? rendered
                : `\n[tool:${toolName}]${rendered ? "\n" + rendered + "\n" : ""}`
            );
          }

          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: rendered || "",
          });
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: `Tool ${toolName} failed: ${msg}`,
          });
        }
      }

      // Loop continues: model will see tool outputs and may request more calls
    }
  } finally {
    await Promise.allSettled(connected.map((c) => c.close()));
  }

  // If we somehow exit the loop without a stop, return the last assistant message we observed
  return lastAssistantText || "finished";
}
