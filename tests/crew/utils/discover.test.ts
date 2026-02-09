import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../../helpers/temp-dirs.js";
import { discoverCrewAgents } from "../../../crew/utils/discover.js";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

function writeAgent(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("crew/utils/discover", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(dirs.root);
  });

  it("discovers crew agents and parses frontmatter fields", () => {
    const userAgentPath = path.join(dirs.root, ".pi", "agent", "agents", "crew-worker.md");
    writeAgent(userAgentPath, `---
name: crew-worker
description: Worker implementation agent
tools: read, bash, pi_messenger
model: gpt-4.1-mini
crewRole: worker
maxOutput: { bytes: 2048, lines: 100 }
---
You are a worker.
`);

    const agents = discoverCrewAgents(dirs.cwd);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("crew-worker");
    expect(agents[0].description).toBe("Worker implementation agent");
    expect(agents[0].tools).toEqual(["read", "bash", "pi_messenger"]);
    expect(agents[0].model).toBe("gpt-4.1-mini");
    expect(agents[0].crewRole).toBe("worker");
    expect(agents[0].maxOutput).toEqual({ bytes: 2048, lines: 100 });
    expect(agents[0].systemPrompt).toContain("You are a worker.");
  });

  it("project agents override user agents with the same name", () => {
    const userAgentPath = path.join(dirs.root, ".pi", "agent", "agents", "crew-reviewer.md");
    const projectAgentPath = path.join(dirs.cwd, ".pi", "agents", "crew-reviewer.md");

    writeAgent(userAgentPath, `---
name: crew-reviewer
description: User reviewer
crewRole: reviewer
model: user-model
---
User prompt.
`);

    writeAgent(projectAgentPath, `---
name: crew-reviewer
description: Project reviewer
crewRole: reviewer
model: project-model
---
Project prompt.
`);

    const agents = discoverCrewAgents(dirs.cwd);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("crew-reviewer");
    expect(agents[0].description).toBe("Project reviewer");
    expect(agents[0].model).toBe("project-model");
    expect(agents[0].source).toBe("project");
    expect(agents[0].systemPrompt).toContain("Project prompt.");
  });

  it("ignores files missing required name/description fields", () => {
    const agentsDir = path.join(dirs.root, ".pi", "agent", "agents");

    writeAgent(path.join(agentsDir, "missing-name.md"), `---
description: Missing name
crewRole: worker
---
Prompt
`);

    writeAgent(path.join(agentsDir, "missing-description.md"), `---
name: unnamed
crewRole: worker
---
Prompt
`);

    writeAgent(path.join(agentsDir, "valid.md"), `---
name: valid-worker
description: Valid
crewRole: worker
---
Prompt
`);

    const agents = discoverCrewAgents(dirs.cwd);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("valid-worker");
  });

  it("parses tools as comma-separated list with trimming", () => {
    const userAgentPath = path.join(dirs.root, ".pi", "agent", "agents", "crew-planner.md");
    writeAgent(userAgentPath, `---
name: crew-planner
description: Planner
tools: read,  bash ,edit,   , write
crewRole: planner
---
Planner prompt
`);

    const agents = discoverCrewAgents(dirs.cwd);
    expect(agents).toHaveLength(1);
    expect(agents[0].tools).toEqual(["read", "bash", "edit", "write"]);
  });

  it("parses model from frontmatter", () => {
    const userAgentPath = path.join(dirs.root, ".pi", "agent", "agents", "crew-analyst.md");
    writeAgent(userAgentPath, `---
name: crew-analyst
description: Analyst
crewRole: analyst
model: claude-3-5-haiku
---
Analyst prompt
`);

    const agents = discoverCrewAgents(dirs.cwd);
    expect(agents).toHaveLength(1);
    expect(agents[0].model).toBe("claude-3-5-haiku");
    expect(agents[0].crewRole).toBe("analyst");
  });
});
