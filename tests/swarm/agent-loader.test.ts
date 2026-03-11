import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadAgentDefinition } from "../../swarm/agent-loader.js";

const roots = new Set<string>();

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-agent-test-"));
  roots.add(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe("agent-loader", () => {
  it("parses frontmatter and returns body as system prompt", () => {
    const dir = createTempDir();
    const file = path.join(dir, "agent.md");
    fs.writeFileSync(
      file,
      `---
role: Security Reviewer
persona: Paranoid about edge cases
model: claude-sonnet-4-6
objective: Review code for security vulnerabilities
---

You are a security expert.`,
      "utf-8"
    );

    const def = loadAgentDefinition(file);
    expect(def.role).toBe("Security Reviewer");
    expect(def.persona).toBe("Paranoid about edge cases");
    expect(def.model).toBe("claude-sonnet-4-6");
    expect(def.objective).toBe("Review code for security vulnerabilities");
    expect(def.systemPrompt).toBe("You are a security expert.");
  });

  it("handles file without frontmatter", () => {
    const dir = createTempDir();
    const file = path.join(dir, "agent.md");
    fs.writeFileSync(file, "Just a system prompt", "utf-8");

    const def = loadAgentDefinition(file);
    expect(def.role).toBe("Subagent");
    expect(def.persona).toBeUndefined();
    expect(def.model).toBeUndefined();
    expect(def.systemPrompt).toBe("Just a system prompt");
  });
});
