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
    .option("--list-prompts", "List all available prompts", false)
    .option(
      "--list-agents",
      "List available agents from config and agentsDir",
      false
    )
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
  llm --list-prompts
  llm --list-agents
  llm --agent researcher "Find sources on topic X"
  llm --no-confirmations "search web"     (run tools without confirmation - planned)
`.trim()
  );

  program.showHelpAfterError();

  // Commander passes (...args, command). Extract flags and positional query safely.
  program.action(async (...actionArgs: any[]) => {
    const command = actionArgs[actionArgs.length - 1];
    const flags: CLIOptions = command?.opts?.() ?? {};
    const positionalRaw = actionArgs.slice(0, -1);
    // Flatten nested arrays and keep only strings
    const queryParts: string[] = positionalRaw
      .flat(Infinity)
      .filter((v: any) => typeof v === "string");

    try {
      const app = loadConfig();

      // Routing flags first
      if (flags.listPrompts) {
        await listPromptTemplates();
        return;
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
