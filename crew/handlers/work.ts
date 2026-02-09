/**
 * Crew - Work Handler
 * 
 * Spawns workers for ready tasks with concurrency control.
 * Simplified: works on current plan's tasks
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Dirs } from "../../lib.js";
import type { CrewParams, AppendEntryFn, Task } from "../types.js";
import { result } from "../utils/result.js";
import { resolveModel, spawnAgents } from "../agents.js";
import { loadCrewConfig } from "../utils/config.js";
import { discoverCrewAgents } from "../utils/discover.js";
import * as store from "../store.js";
import { getCrewDir } from "../store.js";
import { autonomousState, startAutonomous, stopAutonomous, addWaveResult } from "../state.js";

export async function execute(
  params: CrewParams,
  dirs: Dirs,
  ctx: ExtensionContext,
  appendEntry: AppendEntryFn,
  signal?: AbortSignal
) {
  const cwd = ctx.cwd ?? process.cwd();
  const config = loadCrewConfig(getCrewDir(cwd));
  const { autonomous, concurrency: concurrencyOverride } = params;

  // Verify plan exists
  const plan = store.getPlan(cwd);
  if (!plan) {
    return result("No plan found. Create one first:\n\n  pi_messenger({ action: \"plan\" })\n  pi_messenger({ action: \"plan\", prd: \"path/to/PRD.md\" })", {
      mode: "work",
      error: "no_plan"
    });
  }

  // Check for worker agent
  const availableAgents = discoverCrewAgents(cwd);
  const hasWorker = availableAgents.some(a => a.name === "crew-worker");
  if (!hasWorker) {
    return result("Error: crew-worker agent not found. Required for task execution.", {
      mode: "work",
      error: "no_worker"
    });
  }

  // Get ready tasks
  const readyTasks = store.getReadyTasks(cwd);

  if (readyTasks.length === 0) {
    const tasks = store.getTasks(cwd);
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const blocked = tasks.filter(t => t.status === "blocked");
    const done = tasks.filter(t => t.status === "done");

    let reason = "";
    if (done.length === tasks.length) {
      reason = "🎉 All tasks are done! Plan is complete.";
    } else if (inProgress.length > 0) {
      reason = `${inProgress.length} task(s) in progress: ${inProgress.map(t => t.id).join(", ")}`;
    } else if (blocked.length > 0) {
      reason = `${blocked.length} task(s) blocked: ${blocked.map(t => `${t.id} (${t.blocked_reason})`).join(", ")}`;
    } else {
      reason = "All remaining tasks have unmet dependencies.";
    }

    return result(`No ready tasks.\n\n${reason}`, {
      mode: "work",
      prd: plan.prd,
      ready: [],
      reason,
      inProgress: inProgress.map(t => t.id),
      blocked: blocked.map(t => t.id)
    });
  }

  // Determine concurrency
  const concurrency = concurrencyOverride ?? config.concurrency.workers;
  const tasksToRun = readyTasks.slice(0, concurrency);

  // If autonomous mode, set up state and persist (only on first wave or cwd change)
  if (autonomous && (!autonomousState.active || autonomousState.cwd !== cwd)) {
    startAutonomous(cwd);
    appendEntry("crew-state", autonomousState);
  }

  // Spawn workers
  const workerTasks = tasksToRun.map(task => {
    const taskModel = resolveModel(
      task.model,
      params.model,
      config.models?.worker,
      undefined,
    );

    return {
      agent: "crew-worker",
      task: buildWorkerPrompt(task, plan.prd, cwd),
      taskId: task.id,
      modelOverride: taskModel,
    };
  });

  const workerResults = await spawnAgents(
    workerTasks,
    concurrency,
    cwd,
    {
      signal,
      messengerDirs: { registry: dirs.registry, inbox: dirs.inbox },
    }
  );

  // Process results
  const succeeded: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];

  for (let i = 0; i < workerResults.length; i++) {
    const r = workerResults[i];
    const taskId = r.taskId;
    if (!taskId) {
      failed.push(`unknown-result-${i}`);
      continue;
    }
    const task = store.getTask(cwd, taskId);

    if (r.exitCode === 0) {
      if (task?.status === "done") {
        succeeded.push(taskId);
      } else if (task?.status === "blocked") {
        blocked.push(taskId);
      } else if (r.wasGracefullyShutdown && task?.status === "in_progress") {
        store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined });
      } else {
        failed.push(taskId);
      }
    } else {
      if (r.wasGracefullyShutdown) {
        if (task?.status === "done") {
          succeeded.push(taskId);
        } else if (task?.status === "blocked") {
          blocked.push(taskId);
        } else if (task?.status === "in_progress") {
          store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined });
        }
      } else if (autonomous && task?.status === "in_progress") {
        store.blockTask(cwd, taskId, `Worker failed: ${r.error ?? "Unknown error"}`);
        blocked.push(taskId);
      } else {
        failed.push(taskId);
      }
    }
  }

  // Save current wave number BEFORE addWaveResult increments it
  const currentWave = autonomous ? autonomousState.waveNumber : 1;
  
  if (autonomous) {
    addWaveResult({
      waveNumber: currentWave,
      tasksAttempted: tasksToRun.map(t => t.id),
      succeeded,
      failed,
      blocked,
      timestamp: new Date().toISOString()
    });

    if (signal?.aborted) {
      stopAutonomous("manual");
      appendEntry("crew-state", autonomousState);
    } else {
      const nextReady = store.getReadyTasks(cwd);
      const allTasks = store.getTasks(cwd);
      const allDone = allTasks.every(t => t.status === "done");
      const allBlockedOrDone = allTasks.every(t => t.status === "done" || t.status === "blocked");

      if (allDone) {
        stopAutonomous("completed");
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_complete", {
          prd: plan.prd,
          status: "completed",
          totalWaves: currentWave,
          totalTasks: allTasks.length
        });
      } else if (allBlockedOrDone || nextReady.length === 0) {
        stopAutonomous("blocked");
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_blocked", {
          prd: plan.prd,
          status: "blocked",
          blockedTasks: allTasks.filter(t => t.status === "blocked").map(t => t.id)
        });
      } else {
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_continue", {
          prd: plan.prd,
          nextWave: autonomousState.waveNumber,
          readyTasks: nextReady.map(t => t.id)
        });
      }
    }
  }

  // Build result
  const updatedPlan = store.getPlan(cwd);
  const progress = updatedPlan 
    ? `${updatedPlan.completed_count}/${updatedPlan.task_count}`
    : "unknown";

  let statusText = "";
  if (succeeded.length > 0) statusText += `\n✅ Completed: ${succeeded.join(", ")}`;
  if (failed.length > 0) statusText += `\n❌ Failed: ${failed.join(", ")}`;
  if (blocked.length > 0) statusText += `\n🚫 Blocked: ${blocked.join(", ")}`;

  const nextReady = store.getReadyTasks(cwd);
  const nextText = nextReady.length > 0
    ? `\n\n**Ready for next wave:** ${nextReady.map(t => t.id).join(", ")}`
    : "";
  const continueText = autonomous && !signal?.aborted && nextReady.length > 0
    ? "Autonomous mode: Continuing to next wave..."
    : signal?.aborted && autonomous
      ? "Autonomous mode stopped (cancelled)."
      : "";

  const text = `# Work Wave ${currentWave}

**PRD:** ${plan.prd}
**Tasks attempted:** ${tasksToRun.length}
**Progress:** ${progress}
${statusText}${nextText}

${continueText}`;

  return result(text, {
    mode: "work",
    prd: plan.prd,
    wave: currentWave,
    attempted: tasksToRun.map(t => t.id),
    succeeded,
    failed,
    blocked,
    nextReady: nextReady.map(t => t.id),
    autonomous: !!autonomous
  });
}

// =============================================================================
// Worker Prompt Builder
// =============================================================================

function buildWorkerPrompt(task: Task, prdPath: string, cwd: string): string {
  const taskSpec = store.getTaskSpec(cwd, task.id);
  const planSpec = store.getPlanSpec(cwd);

  let prompt = `# Task Assignment

**Task ID:** ${task.id}
**Task Title:** ${task.title}
**PRD:** ${prdPath}
${task.attempt_count >= 1 ? `**Attempt:** ${task.attempt_count + 1} (retry after previous attempt)` : ""}

## Your Mission

Implement this task following the crew-worker protocol:
1. Join the mesh
2. Read task spec to understand requirements
3. Start task and reserve files
4. Implement the feature
5. Commit your changes
6. Release reservations and mark complete

`;

  // Include previous review feedback if this is a retry
  if (task.last_review) {
    prompt += `## ⚠️ Previous Review Feedback

**Verdict:** ${task.last_review.verdict}

${task.last_review.summary}

${task.last_review.issues.length > 0 ? `**Issues to fix:**\n${task.last_review.issues.map(i => `- ${i}`).join("\n")}\n` : ""}
${task.last_review.suggestions.length > 0 ? `**Suggestions:**\n${task.last_review.suggestions.map(s => `- ${s}`).join("\n")}\n` : ""}

**You MUST address the issues above in this attempt.**

`;
  }

  if (taskSpec && !taskSpec.includes("*Spec pending*")) {
    prompt += `## Task Specification

${taskSpec}

`;
  }

  if (task.depends_on.length > 0) {
    prompt += `## Dependencies

This task depends on: ${task.depends_on.join(", ")}
These tasks are already complete - you can reference their implementations.

`;
  }

  if (planSpec && !planSpec.includes("*Spec pending*")) {
    // Include truncated plan spec for context
    const truncatedSpec = planSpec.length > 2000 
      ? planSpec.slice(0, 2000) + `\n\n[Spec truncated - read full spec from .pi/messenger/crew/plan.md]`
      : planSpec;
    prompt += `## Plan Context

${truncatedSpec}
`;
  }

  return prompt;
}
