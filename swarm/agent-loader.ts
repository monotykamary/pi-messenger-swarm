import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";

export interface AgentDefinition {
  role: string;
  persona?: string;
  model?: string;
  objective?: string;
  systemPrompt: string;
}

export function loadAgentDefinition(filePath: string): AgentDefinition {
  const content = fs.readFileSync(filePath, "utf-8");

  // Parse frontmatter
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    // No frontmatter - use whole file as system prompt, defaults for rest
    return {
      role: "Subagent",
      systemPrompt: content.trim(),
    };
  }

  const frontmatter = parseYaml(match[1]) as Record<string, unknown>;
  const body = match[2].trim();

  return {
    role: typeof frontmatter.role === "string" ? frontmatter.role : "Subagent",
    persona: typeof frontmatter.persona === "string" ? frontmatter.persona : undefined,
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    objective: typeof frontmatter.objective === "string" ? frontmatter.objective : undefined,
    systemPrompt: body,
  };
}
