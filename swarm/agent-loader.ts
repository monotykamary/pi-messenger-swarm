import * as fs from "node:fs";

export interface AgentDefinition {
  role: string;
  persona?: string;
  model?: string;
  objective?: string;
  systemPrompt: string;
}

function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    // Remove quotes if present
    result[key] = value.replace(/^["'](.*)["']$/, "$1");
  }
  return result;
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

  const frontmatter = parseSimpleYaml(match[1]);
  const body = match[2].trim();

  return {
    role: frontmatter.role || "Subagent",
    persona: frontmatter.persona,
    model: frontmatter.model,
    objective: frontmatter.objective,
    systemPrompt: body,
  };
}
