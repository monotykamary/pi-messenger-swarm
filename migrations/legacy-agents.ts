import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

const LEGACY_AGENT_FILES = [
  "crew-planner.md",
  "crew-plan-sync.md",
  "crew-worker.md",
  "crew-reviewer.md",
  "crew-repo-scout.md",
  "crew-practice-scout.md",
  "crew-docs-scout.md",
  "crew-web-scout.md",
  "crew-github-scout.md",
  "crew-gap-analyst.md",
  "crew-interview-generator.md",
];

const DEFAULT_MIGRATION_MARKER = "legacy-agent-cleanup-v2.json";

export interface LegacyCleanupOptions {
  homeDir?: string;
  migrationMarker?: string;
}

function getSharedAgentsDir(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "agents");
}

function getMigrationMarkerPath(homeDir: string, marker: string): string {
  return path.join(homeDir, ".pi", "agent", "messenger", "migrations", marker);
}

export function cleanupLegacyAgentFiles(options: LegacyCleanupOptions = {}): { removed: string[]; errors: string[] } {
  const homeDir = options.homeDir ?? homedir();
  const targetAgentsDir = getSharedAgentsDir(homeDir);
  const removed: string[] = [];
  const errors: string[] = [];

  for (const file of LEGACY_AGENT_FILES) {
    const target = path.join(targetAgentsDir, file);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed.push(file);
      }
    } catch (err) {
      errors.push(`Failed to remove ${file}: ${err}`);
    }
  }

  return { removed, errors };
}

export function runLegacyAgentCleanup(options: LegacyCleanupOptions = {}): {
  ran: boolean;
  removed: string[];
  errors: string[];
} {
  const homeDir = options.homeDir ?? homedir();
  const migrationMarker = options.migrationMarker ?? DEFAULT_MIGRATION_MARKER;
  const markerPath = getMigrationMarkerPath(homeDir, migrationMarker);

  if (fs.existsSync(markerPath)) {
    return { ran: false, removed: [], errors: [] };
  }

  const cleanupResult = cleanupLegacyAgentFiles({ homeDir });

  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          migratedAt: new Date().toISOString(),
          removed: cleanupResult.removed,
          errors: cleanupResult.errors,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    cleanupResult.errors.push(`Failed to persist migration marker: ${err}`);
  }

  return { ran: true, removed: cleanupResult.removed, errors: cleanupResult.errors };
}
