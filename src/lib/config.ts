import chalk from "chalk";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseCommentJson } from "comment-json";

import type { AppConfig, ServerConfig } from "../types.js";

export type CLIOptions = {
  listTools?: boolean;
  listPrompts?: boolean;
  noConfirmations?: boolean;
  forceRefresh?: boolean;
  textOnly?: boolean;
  noTools?: boolean;
  noIntermediates?: boolean;
  showMemories?: boolean;
  model?: string;

  // Agents
  listAgents?: boolean;
  agent?: string;
};

const HOME = process.env.HOME || process.env.USERPROFILE || "";

export const DEFAULT_CONFIG_FILE = "mcp-server-config.json";
export const ALT_CONFIG_DIR = `${HOME}/.llm`;
export const ALT_CONFIG_FILE = `${ALT_CONFIG_DIR}/config.json`;

export function loadConfig(): AppConfig & {
  tools_requires_confirmation: string[];
} {
  const possible = [DEFAULT_CONFIG_FILE, ALT_CONFIG_FILE];
  const chosen = possible.find((p) => existsSync(p));
  if (!chosen) {
    throw new Error(
      `Config file not found. Tried: ${possible.join(", ")}. Create ${chalk.cyan(
        ALT_CONFIG_FILE
      )} (see README)`
    );
  }
  const raw = readFileSync(chosen, "utf-8");
  // supports comments
  const conf = parseCommentJson(raw, undefined, true) as any;

  const tools_requires_confirmation: string[] = [];
  const servers = conf?.mcpServers ?? {};
  for (const k of Object.keys(servers)) {
    const sc: ServerConfig = servers[k];
    if (Array.isArray(sc?.requires_confirmation)) {
      tools_requires_confirmation.push(...sc.requires_confirmation);
    }
  }

  return {
    ...(conf as AppConfig),
    tools_requires_confirmation,
  };
}
