import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../../helpers/temp-dirs.js";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

async function loadConfigModule() {
  vi.resetModules();
  return import("../../../crew/utils/config.js");
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe("crew/utils/config", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(dirs.root);
  });

  it("loadCrewConfig merges defaults <- user <- project in order", async () => {
    const userConfigPath = path.join(dirs.root, ".pi", "agent", "pi-messenger.json");
    writeJson(userConfigPath, {
      crew: {
        concurrency: { workers: 4 },
        truncation: { workers: { bytes: 999, lines: 123 } },
        work: { maxWaves: 12 },
      },
    });

    writeJson(path.join(dirs.crewDir, "config.json"), {
      concurrency: { workers: 6 },
      work: { maxWaves: 21, stopOnBlock: true },
    });

    const { loadCrewConfig } = await loadConfigModule();
    const cfg = loadCrewConfig(dirs.crewDir);

    expect(cfg.concurrency.workers).toBe(6);
    expect(cfg.work.maxWaves).toBe(21);
    expect(cfg.work.stopOnBlock).toBe(true);
    expect(cfg.work.maxAttemptsPerTask).toBe(5);
    expect(cfg.truncation.workers.bytes).toBe(999);
    expect(cfg.truncation.workers.lines).toBe(123);
    expect(cfg.artifacts.enabled).toBe(true);
  });

  it("loadCrewConfig returns defaults when user/project files are missing", async () => {
    const { loadCrewConfig } = await loadConfigModule();
    const cfg = loadCrewConfig(dirs.crewDir);

    expect(cfg.concurrency.workers).toBe(2);
    expect(cfg.artifacts.enabled).toBe(true);
    expect(cfg.artifacts.cleanupDays).toBe(7);
    expect(cfg.planning.maxPasses).toBe(3);
    expect(cfg.work.maxAttemptsPerTask).toBe(5);
    expect(cfg.work.maxWaves).toBe(50);
    expect(cfg.work.stopOnBlock).toBe(false);
  });

  it("getTruncationForRole returns role-specific truncation settings", async () => {
    writeJson(path.join(dirs.crewDir, "config.json"), {
      truncation: {
        planners: { bytes: 1, lines: 2 },
        workers: { bytes: 3, lines: 4 },
        reviewers: { bytes: 5, lines: 6 },
        analysts: { bytes: 7, lines: 8 },
      },
    });

    const { loadCrewConfig, getTruncationForRole } = await loadConfigModule();
    const cfg = loadCrewConfig(dirs.crewDir);

    expect(getTruncationForRole(cfg, "planner")).toEqual({ bytes: 1, lines: 2 });
    expect(getTruncationForRole(cfg, "worker")).toEqual({ bytes: 3, lines: 4 });
    expect(getTruncationForRole(cfg, "reviewer")).toEqual({ bytes: 5, lines: 6 });
    expect(getTruncationForRole(cfg, "analyst")).toEqual({ bytes: 7, lines: 8 });
    expect(getTruncationForRole(cfg, "unknown")).toEqual({ bytes: 3, lines: 4 });
  });

  it("deep merge handles nested object values with absent keys", async () => {
    const userConfigPath = path.join(dirs.root, ".pi", "agent", "pi-messenger.json");
    writeJson(userConfigPath, {
      crew: {
        work: {
          env: {
            OPENAI_API_BASE: "https://example.test",
            OPENAI_API_KEY: "redacted",
          },
          shutdownGracePeriodMs: 45000,
        },
        models: {
          worker: "model-a",
        },
      },
    });

    const { loadCrewConfig } = await loadConfigModule();
    const cfg = loadCrewConfig(dirs.crewDir);

    expect(cfg.work.env?.OPENAI_API_BASE).toBe("https://example.test");
    expect(cfg.work.shutdownGracePeriodMs).toBe(45000);
    expect(cfg.models?.worker).toBe("model-a");
    expect(cfg.concurrency.workers).toBe(2);
  });
});
