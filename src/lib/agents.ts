import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename, isAbsolute } from "node:path";
import { parse as parseCommentJson } from "comment-json";
import { homedir } from "node:os";
import consola from "consola";
import type { AgentConfig, AppConfig } from "../types.js";

/**
 * Resolve candidate agent directories in priority order:
 * 1) Explicit app.agentsDir (if provided)
 * 2) Project local ./agents
 * 3) Global ~/.llm/agents
 */
function resolveAgentDirs(explicit?: string): string[] {
  const dirs: string[] = [];
  if (explicit) dirs.push(explicit);
  dirs.push(join(process.cwd(), "agents"));
  dirs.push(join(homedir(), ".llm", "agents"));
  // Deduplicate while preserving order
  return Array.from(new Set(dirs));
}

/**
 * Load .json/.jsonc files from a directory into a map of agentName -> AgentConfig.
 * The filename (without extension) is used as the agent name.
 */
function loadAgentsFromDir(dir: string): Record<string, AgentConfig> {
  const out: Record<string, AgentConfig> = {};
  if (!existsSync(dir)) return out;

  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (e: any) {
    consola.warn(`Cannot read agents directory ${dir}: ${e?.message || e}`);
    return out;
  }

  for (const f of entries) {
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      const ext = extname(f).toLowerCase();
      if (ext !== ".json" && ext !== ".jsonc") continue;

      const raw = readFileSync(p, "utf-8");
      const conf = parseCommentJson(raw, undefined, true) as AgentConfig;
      const name = basename(f, ext);

      // If an external prompt file is specified, resolve relative to the agent file's directory
      // and load its contents into systemPrompt. The file takes precedence over inline prompt.
      if (conf && typeof (conf as any).systemPromptFile === "string") {
        const promptPath = (conf as any).systemPromptFile as string;
        try {
          const resolved = isAbsolute(promptPath)
            ? promptPath
            : join(dir, promptPath);
          const promptText = readFileSync(resolved, "utf-8");
          (conf as any).systemPrompt = promptText;
        } catch (e: any) {
          consola.warn(
            `Agent '${name}': failed to read systemPromptFile '${promptPath}': ${e?.message || e}`
          );
        }
      }

      out[name] = conf;
    } catch (e: any) {
      consola.warn(`Skipping agent file ${p}: ${e?.message || e}`);
    }
  }
  return out;
}

/**
 * Merge inline agents (app.agents) and directory agents.
 * Directory agents override inline agents on name conflicts.
 */
export function loadAgents(app: Pick<AppConfig, "agents" | "agentsDir">): {
  agents: Record<string, AgentConfig>;
  names: string[];
} {
  const dirs = resolveAgentDirs(app.agentsDir);
  let dirAgents: Record<string, AgentConfig> = {};
  for (const d of dirs) {
    const loaded = loadAgentsFromDir(d);
    // Earlier directories should win; only fill in keys not yet set
    dirAgents = { ...loaded, ...dirAgents };
  }
  const merged: Record<string, AgentConfig> = {
    ...(app.agents ?? {}),
    ...dirAgents,
  };

  // For inline agents (or any not already resolved), allow systemPromptFile.
  // Resolve relative to process.cwd() and let file contents take precedence.
  for (const [agentName, a] of Object.entries(merged)) {
    const filePath = (a as any)?.systemPromptFile;
    if (typeof filePath === "string") {
      try {
        const resolved = isAbsolute(filePath)
          ? filePath
          : join(process.cwd(), filePath);
        const promptText = readFileSync(resolved, "utf-8");
        (a as any).systemPrompt = promptText;
      } catch (e: any) {
        consola.warn(
          `Agent '${agentName}': failed to read systemPromptFile '${filePath}': ${e?.message || e}`
        );
      }
    }
  }

  const names = Object.keys(merged).sort();
  return { agents: merged, names };
}

/**
 * Get an agent by name after merge.
 */
export function getAgent(
  app: Pick<AppConfig, "agents" | "agentsDir">,
  name: string
): AgentConfig | undefined {
  const { agents } = loadAgents(app);
  return agents[name];
}

/**
 * List agent names after merge.
 */
export function listAgents(
  app: Pick<AppConfig, "agents" | "agentsDir">
): string[] {
  return loadAgents(app).names;
}
