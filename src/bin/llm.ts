#!/usr/bin/env node
/**
 * TypeScript CLI for MCP client with OpenAI.
 * Now split into a small CLI entry that delegates to lib/llm-core.
 */

import { Command } from "commander";
import consola from "consola";
import { promptTemplates } from "../prompts.js";
import type { CLIOptions } from "../lib/config.js";
import { loadConfig } from "../lib/config.js";
import { listAllTools } from "../lib/mcp.js";
import {
  listPrompts as listPromptTemplates,
  chatWithOpenAI,
} from "../lib/llm-core.js";
import { listAgents } from "../lib/agents.js";
import {
  listMcpServers as agentGenListMcpServers,
  createAgentFile as agentGenCreateAgentFile,
  updateAgentFile as agentGenUpdateAgentFile,
  listAgentsMerged as agentGenListAgentsMerged,
  generateAgentsFromUseCase as agentGenGenerateFromUseCase,
} from "../lib/agentgen.js";

// -------------------------
// Main
// -------------------------
async function main() {
  const program = new Command();
  program
    .name("llm")
    .description("Run LLM prompts with MCP tools")
    .argument("[query...]", "The query to process")
    .option("--list-tools", "List all available LLM tools", false)
    .option(
      "--list-tools-by-server",
      "List MCP tools grouped by server (read-only discovery)",
      false
    )
    .option("--list-prompts", "List all available prompts", false)
    .option(
      "--list-agents",
      "List available agents from config and agentsDir",
      false
    )
    // Agent Generator (read/create/edit, inspect MCP servers)
    .option(
      "--list-mcp-servers",
      "List configured MCP servers (no connect/use)",
      false
    )
    .option(
      "--list-agents-merged",
      "List agents after merge (inline + directories)",
      false
    )
    .option("--create-agent <name>", "Create a new agent file in agents dir")
    .option("--update-agent <name>", "Update an existing agent file")
    .option("--agent-desc <text>", "Agent description for create/update")
    .option("--agent-prompt <text>", "Agent system prompt for create/update")
    .option(
      "--agent-servers-include <spec>",
      "Per-server include list spec: serverA=tool1,tool2;serverB=toolX"
    )
    .option(
      "--agent-servers-exclude <spec>",
      "Per-server exclude list spec: serverA=toolY;serverB=toolZ,toolW"
    )
    .option("--force", "Force overwrite when creating existing agent", false)
    // AI-powered multi-agent generation from a use case
    .option(
      "--generate-from-use-case <text>",
      "AI-generate one or more agent definition files from a natural-language use case"
    )
    .option("--dry-run", "Plan only; do not write files", false)
    .option(
      "--agent <name>",
      "Run with a specific agent scope (server/tool whitelist)"
    )
    .option(
      "--no-confirmations",
      "Bypass tool confirmation requirements",
      false
    )
    .option("--force-refresh", "Force refresh of tools capabilities", false)
    .option("--text-only", "Print output as raw text", false)
    .option("--no-tools", "Do not add any tools", false)
    .option("--no-intermediates", "Only print the final message", false)
    .option("--show-memories", "Show user memories", false)
    .option("--model <model>", "Override the model specified in config");

  program.addHelpText(
    "after",
    `
Examples:
  llm "What is the capital of France?"
  llm c "tell me more"                    (continue previous conversation - planned)
  llm p review                            (use a prompt template)
  cat file.txt | llm                      (stdin pipeline - planned)
  llm --list-tools
  llm --list-tools-by-server              (same as --list-tools; grouped by server)
  llm --list-prompts
  llm --list-agents
  llm --list-mcp-servers                  (show configured servers without connecting)
  llm --list-agents-merged                (show merged agent names)
  llm --create-agent researcher \\
      --agent-desc "Research assistant" \\
      --agent-prompt "You are a focused research assistant." \\
      --agent-servers-include "brave-search=search,news_search" \\
      --agent-servers-exclude "mcp-server-commands=run_command,run_script"
  llm --update-agent researcher --agent-servers-include "brave-search=search"
  llm --generate-from-use-case "Daily market news triage and email summaries" --dry-run
  llm --agent researcher "Find sources on topic X"
  llm --no-confirmations "search web"     (run tools without confirmation - planned)
`.trim()
  );

  program.showHelpAfterError();

  // Commander passes (...args, command). Extract flags and positional query safely.
  program.action(async (...actionArgs: any[]) => {
    const command = actionArgs[actionArgs.length - 1];
    const flags: CLIOptions & {
      listMcpServers?: boolean;
      listAgentsMerged?: boolean;
      createAgent?: string;
      updateAgent?: string;
      agentDesc?: string;
      agentPrompt?: string;
      agentServersInclude?: string;
      agentServersExclude?: string;
      force?: boolean;
      generateFromUseCase?: string;
      dryRun?: boolean;
    } = command?.opts?.() ?? {};
    const positionalRaw = actionArgs.slice(0, -1);
    // Flatten nested arrays and keep only strings
    const queryParts: string[] = positionalRaw
      .flat(Infinity)
      .filter((v: any) => typeof v === "string");

    try {
      const app = loadConfig();

      // -------------------------
      // Agent Generator helpers
      // -------------------------
      const parseServerSpec = (
        spec?: string
      ): Record<string, { include?: string[]; exclude?: string[] }> => {
        // Spec format: "serverA=tool1,tool2;serverB=toolX"
        if (!spec) return {};
        const out: Record<string, { include?: string[]; exclude?: string[] }> =
          {};
        for (const segment of spec
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)) {
          const [server, toolsStr] = segment.split("=").map((s) => s.trim());
          if (!server) continue;
          if (!out[server]) out[server] = {};
          const tools = (toolsStr || "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          // Caller will assign these to either include or exclude lists
          out[server] = {
            ...(out[server] ?? {}),
            include: tools.length ? tools : undefined,
          };
        }
        return out;
      };

      const mergeIncludeExclude = (
        includeSpec?: string,
        excludeSpec?: string
      ): Record<string, { include?: string[]; exclude?: string[] }> => {
        const inc = parseServerSpec(includeSpec);
        const excRaw = parseServerSpec(excludeSpec);
        const out: Record<string, { include?: string[]; exclude?: string[] }> =
          {};
        const servers = new Set([...Object.keys(inc), ...Object.keys(excRaw)]);
        for (const s of servers) {
          out[s] = {
            include: inc[s]?.include,
            exclude: excRaw[s]?.include, // in excludeSpec we used the same parser; treat its "include" as exclude list
          };
        }
        return out;
      };

      // Routing flags first
      if (flags.listPrompts) {
        await listPromptTemplates();
        return;
      }

      // -------------------------
      // Agent Generator entrypoints (no tool execution)
      // -------------------------
      if (flags.listMcpServers) {
        agentGenListMcpServers(app);
        process.exit(0);
      }

      if (flags.listAgentsMerged) {
        agentGenListAgentsMerged(app);
        process.exit(0);
      }

      if (flags.generateFromUseCase) {
        await agentGenGenerateFromUseCase(
          app as any,
          flags.generateFromUseCase,
          {
            force: !!flags.force,
            dryRun: !!flags.dryRun,
          }
        );
        process.exit(0);
      }

      if (flags.createAgent) {
        const serverPolicy = mergeIncludeExclude(
          flags.agentServersInclude,
          flags.agentServersExclude
        );
        agentGenCreateAgentFile(app, flags.createAgent, {
          description: flags.agentDesc,
          systemPrompt: flags.agentPrompt,
          servers: serverPolicy,
          force: !!flags.force,
        });
        process.exit(0);
      }

      if (flags.updateAgent) {
        const serverPolicy = mergeIncludeExclude(
          flags.agentServersInclude,
          flags.agentServersExclude
        );
        agentGenUpdateAgentFile(app, flags.updateAgent, {
          description: flags.agentDesc ?? undefined,
          systemPrompt: flags.agentPrompt ?? undefined,
          servers: Object.keys(serverPolicy).length ? serverPolicy : undefined,
        });
        process.exit(0);
      }

      if (flags.listTools) {
        await listAllTools(app, flags);
        // Ensure process exits after listing tools (some MCP servers may keep stdio open)
        process.exit(0);
      }

      if (flags.listAgents) {
        const names = listAgents(app);
        if (!names.length) {
          consola.info(
            "No agents found. Add JSON/JSONC files to ./agents or ~/.llm/agents, or define inline under 'agents' in config."
          );
        } else {
          console.log("\n\x1b[1mAvailable Agents\x1b[0m\n");
          for (const n of names) console.log("- " + n);
          console.log("");
        }
        process.exit(0);
      }

      if (flags.showMemories) {
        consola.info(
          "show-memories not implemented yet (planned: lowdb store)."
        );
        return;
      }

      // Parse query: prompt templates support ("p <name> ...")
      let queryText = queryParts.join(" ").trim();
      if (!queryText) {
        consola.error("No query provided");
        process.exitCode = 1;
        return;
      }

      const tokens = queryText.split(/\s+/);
      if (tokens[0] === "p" && tokens[1]) {
        const name = tokens[1];
        const tpl = promptTemplates[name];
        if (!tpl) {
          consola.error(
            `Prompt '${name}' not found. Use --list-prompts to see available templates.`
          );
          process.exitCode = 1;
          return;
        }
        const varNames = Array.from(tpl.matchAll(/\{(\w+)\}/g)).map(
          (m) => m[1]
        );
        const provided = tokens.slice(2);
        const dict: Record<string, string> = {};
        for (let i = 0; i < varNames.length; i++) {
          dict[varNames[i]] = provided[i] ?? "";
        }
        queryText = tpl.replace(
          /\{(\w+)\}/g,
          (_: string, k: string) => dict[k] ?? ""
        );
      } else if (tokens[0] === "c") {
        // planned: continue previous conversation (thread id)
        queryText = tokens.slice(1).join(" ");
      }

      await chatWithOpenAI(app, queryText, flags);
      // Ensure the CLI terminates after the chat completes (avoid lingering stdio handles)
      process.exit(0);
    } catch (err: any) {
      consola.error(err?.message || String(err));
      process.exitCode = 1;
      process.exit(1);
    }
  });

  await program.parseAsync(process.argv);
  // In case no action handler ran (e.g., help), allow Node to exit naturally
}

main().catch((e) => {
  consola.error(e);
  process.exit(1);
});
