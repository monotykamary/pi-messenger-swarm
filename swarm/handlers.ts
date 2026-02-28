import type { CrewParams } from "../crew/types.js";
import type { MessengerState } from "../lib.js";
import { result } from "../crew/utils/result.js";
import { logFeedEvent } from "../feed.js";
import * as store from "./store.js";
import { cleanupExitedSpawned, listSpawned, spawnSubagent, stopSpawn } from "./spawn.js";
import type { SpawnRequest, SwarmTaskEvidence } from "./types.js";

function summaryLine(cwd: string): string {
  const s = store.getSummary(cwd);
  return `${s.done}/${s.total} done · ${s.in_progress} in progress · ${s.todo} todo · ${s.blocked} blocked`;
}

export function executeSwarmStatus(cwd: string) {
  cleanupExitedSpawned(cwd);
  const tasks = store.getTasks(cwd);
  const summary = store.getSummary(cwd);
  const spawned = listSpawned(cwd);

  if (tasks.length === 0) {
    return result(
      `# Agent Swarm\n\nNo tasks yet.\n\nCreate one:\n  pi_messenger({ action: "task.create", title: "...", content: "..." })\n\nSpawn a subagent:\n  pi_messenger({ action: "spawn", role: "Researcher", message: "Investigate ..." })`,
      {
        mode: "swarm",
        summary,
        tasks: [],
        spawned,
      },
    );
  }

  const lines: string[] = ["# Agent Swarm", "", `Summary: ${summaryLine(cwd)}`, ""];

  if (spawned.length > 0) {
    lines.push("## Spawned Agents");
    for (const agent of spawned.slice(0, 8)) {
      const suffix = agent.taskId ? ` → ${agent.taskId}` : "";
      lines.push(`- ${agent.id} · ${agent.name} (${agent.role}) · ${agent.status}${suffix}`);
    }
    lines.push("");
  }

  lines.push("## Tasks");
  for (const task of tasks) {
    const icon = task.status === "done" ? "✅" : task.status === "in_progress" ? "🔄" : task.status === "blocked" ? "🚫" : "⬜";
    const owner = task.claimed_by ? ` (${task.claimed_by})` : "";
    const deps = task.depends_on.length > 0 ? ` → deps: ${task.depends_on.join(", ")}` : "";
    lines.push(`${icon} ${task.id}: ${task.title}${owner}${deps}`);
  }

  return result(lines.join("\n"), {
    mode: "swarm",
    summary,
    tasks,
    spawned,
  });
}

export function executeTask(op: string, params: CrewParams, state: MessengerState, cwd: string) {
  switch (op) {
    case "create":
      return taskCreate(params, state, cwd);
    case "list":
      return taskList(cwd);
    case "show":
      return taskShow(params, cwd);
    case "start":
    case "claim":
      return taskClaim(params, state, cwd);
    case "unclaim":
    case "stop":
      return taskUnclaim(params, state, cwd);
    case "done":
      return taskDone(params, state, cwd);
    case "block":
      return taskBlock(params, state, cwd);
    case "unblock":
      return taskUnblock(params, state, cwd);
    case "ready":
      return taskReady(cwd);
    case "progress":
      return taskProgress(params, state, cwd);
    case "reset":
      return taskReset(params, state, cwd);
    case "delete":
      return taskDelete(params, state, cwd);
    case "archive_done":
      return taskArchiveDone(state, cwd);
    default:
      return result(`Unknown task operation: ${op}`, { mode: "task", error: "unknown_operation", operation: op });
  }
}

function taskCreate(params: CrewParams, state: MessengerState, cwd: string) {
  if (!params.title) {
    return result("Error: title required for task.create", { mode: "task.create", error: "missing_title" });
  }

  const dependsOn = params.dependsOn ?? [];
  for (const depId of dependsOn) {
    if (!store.getTask(cwd, depId)) {
      return result(`Error: dependency ${depId} not found`, {
        mode: "task.create",
        error: "dependency_not_found",
        dependency: depId,
      });
    }
  }

  const task = store.createTask(cwd, {
    title: params.title,
    content: params.content,
    dependsOn,
    createdBy: state.agentName,
  });

  logFeedEvent(cwd, state.agentName, "task.start", task.id, `created ${task.title}`);

  const deps = task.depends_on.length > 0 ? `\nDepends on: ${task.depends_on.join(", ")}` : "";

  return result(
    `✅ Created ${task.id}: ${task.title}${deps}\n\nClaim it:\n  pi_messenger({ action: "task.claim", id: "${task.id}" })`,
    {
      mode: "task.create",
      task,
    },
  );
}

function taskList(cwd: string) {
  const tasks = store.getTasks(cwd);
  if (tasks.length === 0) {
    return result("No tasks yet. Create one with task.create.", { mode: "task.list", tasks: [] });
  }

  const lines: string[] = ["# Swarm Tasks", "", `Summary: ${summaryLine(cwd)}`, ""];
  for (const task of tasks) {
    const icon = task.status === "done" ? "✅" : task.status === "in_progress" ? "🔄" : task.status === "blocked" ? "🚫" : "⬜";
    const owner = task.claimed_by ? ` [${task.claimed_by}]` : "";
    const deps = task.depends_on.length > 0 ? ` → ${task.depends_on.join(", ")}` : "";
    lines.push(`${icon} ${task.id}: ${task.title}${owner}${deps}`);
  }

  return result(lines.join("\n"), {
    mode: "task.list",
    tasks,
  });
}

function taskShow(params: CrewParams, cwd: string) {
  if (!params.id) return result("Error: id required for task.show", { mode: "task.show", error: "missing_id" });

  const task = store.getTask(cwd, params.id);
  if (!task) return result(`Error: task ${params.id} not found`, { mode: "task.show", error: "not_found", id: params.id });

  const spec = store.getTaskSpec(cwd, task.id) ?? "*No spec*";
  const progress = store.getTaskProgress(cwd, task.id);

  const lines: string[] = [
    `# ${task.id}: ${task.title}`,
    "",
    `Status: ${task.status}`,
    task.claimed_by ? `Claimed by: ${task.claimed_by}` : "Claimed by: (none)",
    task.depends_on.length > 0 ? `Depends on: ${task.depends_on.join(", ")}` : "Depends on: (none)",
    "",
    "## Spec",
    spec,
  ];

  if (progress) {
    lines.push("", "## Progress", progress.trimEnd());
  }

  return result(lines.join("\n"), { mode: "task.show", task, hasProgress: !!progress });
}

function taskClaim(params: CrewParams, state: MessengerState, cwd: string) {
  if (!params.id) return result("Error: id required for task.claim", { mode: "task.claim", error: "missing_id" });

  const claimed = store.claimTask(cwd, params.id, state.agentName, params.reason);
  if (!claimed) {
    const existing = store.getTask(cwd, params.id);
    if (!existing) return result(`Error: task ${params.id} not found`, { mode: "task.claim", error: "not_found", id: params.id });
    if (existing.status === "in_progress") {
      return result(`Error: ${params.id} is already claimed by ${existing.claimed_by ?? "another agent"}.`, {
        mode: "task.claim",
        error: "already_claimed",
        id: params.id,
        claimedBy: existing.claimed_by,
      });
    }
    if (existing.status === "done") {
      return result(`Error: ${params.id} is already completed.`, {
        mode: "task.claim",
        error: "already_done",
        id: params.id,
      });
    }
    return result(`Error: ${params.id} is not ready to claim (check dependencies).`, {
      mode: "task.claim",
      error: "not_ready",
      id: params.id,
    });
  }

  logFeedEvent(cwd, state.agentName, "task.start", claimed.id, claimed.title);

  return result(`🔄 Claimed ${claimed.id}: ${claimed.title}`, {
    mode: "task.claim",
    task: claimed,
  });
}

function taskUnclaim(params: CrewParams, state: MessengerState, cwd: string) {
  if (!params.id) return result("Error: id required for task.unclaim", { mode: "task.unclaim", error: "missing_id" });

  const unclaimed = store.unclaimTask(cwd, params.id, state.agentName);
  if (!unclaimed) {
    const existing = store.getTask(cwd, params.id);
    if (!existing) return result(`Error: task ${params.id} not found`, { mode: "task.unclaim", error: "not_found", id: params.id });
    return result(`Error: ${params.id} cannot be unclaimed by ${state.agentName}.`, {
      mode: "task.unclaim",
      error: "not_owner",
      id: params.id,
      claimedBy: existing.claimed_by,
    });
  }

  logFeedEvent(cwd, state.agentName, "task.reset", unclaimed.id, "unclaimed");

  return result(`Released claim on ${unclaimed.id}.`, {
    mode: "task.unclaim",
    task: unclaimed,
  });
}

function taskDone(params: CrewParams, state: MessengerState, cwd: string) {
  if (!params.id) return result("Error: id required for task.done", { mode: "task.done", error: "missing_id" });

  const summary = params.summary ?? "Task completed";
  const evidence = params.evidence as SwarmTaskEvidence | undefined;
  const completed = store.completeTask(cwd, params.id, state.agentName, summary, evidence);

  if (!completed) {
    const task = store.getTask(cwd, params.id);
    if (!task) return result(`Error: task ${params.id} not found`, { mode: "task.done", error: "not_found", id: params.id });
    if (task.status !== "in_progress") {
      return result(`Error: ${params.id} is ${task.status}, not in_progress.`, {
        mode: "task.done",
        error: "invalid_status",
        id: params.id,
      });
    }
    return result(`Error: ${params.id} is claimed by ${task.claimed_by ?? "another agent"}.`, {
      mode: "task.done",
      error: "not_owner",
      id: params.id,
      claimedBy: task.claimed_by,
    });
  }

  logFeedEvent(cwd, state.agentName, "task.done", completed.id, summary);

  return result(`✅ Completed ${completed.id}: ${completed.title}\n\nSummary: ${summary}`, {
    mode: "task.done",
    task: completed,
    summary: store.getSummary(cwd),
  });
}

function taskBlock(params: CrewParams, state: MessengerState, cwd: string) {
  if (!params.id) return result("Error: id required for task.block", { mode: "task.block", error: "missing_id" });
  if (!params.reason) return result("Error: reason required for task.block", { mode: "task.block", error: "missing_reason" });

  const blocked = store.blockTask(cwd, params.id, state.agentName, params.reason);
  if (!blocked) return result(`Error: failed to block ${params.id}.`, { mode: "task.block", error: "block_failed", id: params.id });

  logFeedEvent(cwd, state.agentName, "task.block", blocked.id, params.reason);

  return result(`🚫 Blocked ${blocked.id}: ${params.reason}`, {
    mode: "task.block",
    task: blocked,
  });
}

function taskUnblock(params: CrewParams, state: MessengerState, cwd: string) {
  if (!params.id) return result("Error: id required for task.unblock", { mode: "task.unblock", error: "missing_id" });

  const task = store.unblockTask(cwd, params.id);
  if (!task) return result(`Error: failed to unblock ${params.id}.`, { mode: "task.unblock", error: "unblock_failed", id: params.id });

  logFeedEvent(cwd, state.agentName, "task.unblock", task.id, task.title);

  return result(`⬜ Unblocked ${task.id}.`, {
    mode: "task.unblock",
    task,
  });
}

function taskReady(cwd: string) {
  const ready = store.getReadyTasks(cwd);
  if (ready.length === 0) {
    return result("No ready tasks right now.", {
      mode: "task.ready",
      ready: [],
      summary: store.getSummary(cwd),
    });
  }

  const lines = ["# Ready Tasks", "", ...ready.map(task => `- ${task.id}: ${task.title}`)];
  return result(lines.join("\n"), {
    mode: "task.ready",
    ready,
  });
}

function taskProgress(params: CrewParams, state: MessengerState, cwd: string) {
  if (!params.id) return result("Error: id required for task.progress", { mode: "task.progress", error: "missing_id" });
  if (!params.message) return result("Error: message required for task.progress", { mode: "task.progress", error: "missing_message" });

  const task = store.getTask(cwd, params.id);
  if (!task) return result(`Error: task ${params.id} not found`, { mode: "task.progress", error: "not_found", id: params.id });

  store.appendTaskProgress(cwd, task.id, state.agentName, params.message);
  return result(`Progress logged for ${task.id}.`, {
    mode: "task.progress",
    id: task.id,
  });
}

function taskReset(params: CrewParams, state: MessengerState, cwd: string) {
  if (!params.id) return result("Error: id required for task.reset", { mode: "task.reset", error: "missing_id" });

  const cascade = params.cascade === true;
  const reset = store.resetTask(cwd, params.id, cascade);
  if (reset.length === 0) {
    return result(`Error: failed to reset ${params.id}.`, {
      mode: "task.reset",
      error: "reset_failed",
      id: params.id,
    });
  }

  logFeedEvent(cwd, state.agentName, "task.reset", params.id, cascade ? `cascade (${reset.length})` : "reset");

  return result(`🔄 Reset ${reset.length} task(s): ${reset.map(task => task.id).join(", ")}`, {
    mode: "task.reset",
    reset: reset.map(task => task.id),
    cascade,
  });
}

function taskDelete(params: CrewParams, state: MessengerState, cwd: string) {
  if (!params.id) return result("Error: id required for task.delete", { mode: "task.delete", error: "missing_id" });

  const task = store.getTask(cwd, params.id);
  if (!task) {
    return result(`Error: task ${params.id} not found`, {
      mode: "task.delete",
      error: "not_found",
      id: params.id,
    });
  }

  if (task.status === "in_progress") {
    return result(`Error: cannot delete ${params.id} while in progress.`, {
      mode: "task.delete",
      error: "in_progress",
      id: params.id,
    });
  }

  if (!store.deleteTask(cwd, task.id)) {
    return result(`Error: failed to delete ${params.id}.`, {
      mode: "task.delete",
      error: "delete_failed",
      id: params.id,
    });
  }

  logFeedEvent(cwd, state.agentName, "task.delete", task.id, task.title);

  return result(`Deleted ${task.id}: ${task.title}`, {
    mode: "task.delete",
    id: task.id,
  });
}

function taskArchiveDone(state: MessengerState, cwd: string) {
  const archived = store.archiveDoneTasks(cwd);
  if (archived.archived === 0) {
    return result("No done tasks to archive.", {
      mode: "task.archive_done",
      archived: 0,
      archivedIds: [],
      archiveDir: null,
    });
  }

  logFeedEvent(cwd, state.agentName, "task.archive", undefined, `${archived.archived} done task(s)`);

  return result(
    `Archived ${archived.archived} done task(s): ${archived.archivedIds.join(", ")}\nArchive: ${archived.archiveDir}`,
    {
      mode: "task.archive_done",
      archived: archived.archived,
      archivedIds: archived.archivedIds,
      archiveDir: archived.archiveDir,
      summary: store.getSummary(cwd),
    },
  );
}

export function executeSpawn(op: string | null, params: CrewParams, state: MessengerState, cwd: string) {
  cleanupExitedSpawned(cwd);

  if (!op) {
    return spawnCreate(params, state, cwd);
  }

  if (op === "list") {
    const items = listSpawned(cwd);
    if (items.length === 0) {
      return result("No spawned agents for this project.", { mode: "spawn.list", agents: [] });
    }

    const lines = ["# Spawned Agents", "", ...items.map(agent => {
      const tail = agent.taskId ? ` → ${agent.taskId}` : "";
      return `- ${agent.id}: ${agent.name} (${agent.role}) · ${agent.status}${tail}`;
    })];

    return result(lines.join("\n"), {
      mode: "spawn.list",
      agents: items,
    });
  }

  if (op === "stop") {
    const id = params.id;
    if (!id) {
      return result("Error: id required for spawn.stop", { mode: "spawn.stop", error: "missing_id" });
    }

    const stopped = stopSpawn(cwd, id);
    if (!stopped) {
      return result(`Error: could not stop spawn ${id}.`, {
        mode: "spawn.stop",
        error: "not_found_or_not_running",
        id,
      });
    }

    return result(`Stopping spawned agent ${id}...`, {
      mode: "spawn.stop",
      id,
    });
  }

  return result(`Unknown spawn operation: ${op}`, {
    mode: "spawn",
    error: "unknown_operation",
    operation: op,
  });
}

function spawnCreate(params: CrewParams, state: MessengerState, cwd: string) {
  const objective = params.message?.trim() || params.prompt?.trim();
  if (!objective) {
    return result("Error: spawn requires mission text via message or prompt.", {
      mode: "spawn",
      error: "missing_objective",
    });
  }

  const role = params.role?.trim() || params.title?.trim() || "Subagent";
  const request: SpawnRequest = {
    role,
    persona: params.persona,
    objective,
    context: params.content,
    taskId: params.taskId,
    model: params.model,
    name: params.name,
  };

  const record = spawnSubagent(cwd, request);
  logFeedEvent(cwd, state.agentName, "message", undefined, `spawned ${record.name} (${record.role})`);

  return result(`🚀 Spawned ${record.name} (${record.id}) as ${record.role}.`, {
    mode: "spawn",
    agent: record,
  });
}
