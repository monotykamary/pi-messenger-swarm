/**
 * Pi Messenger - Action Router
 *
 * Swarm-first router. Legacy crew actions are disabled and return
 * migration guidance.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs, AgentMailMessage, NameThemeConfig } from "../lib.js";
import * as handlers from "../handlers.js";
import type { CrewParams, AppendEntryFn } from "./types.js";
import { result } from "./utils/result.js";
import { executeSpawn, executeSwarmStatus, executeTask } from "../swarm/handlers.js";

type DeliverFn = (msg: AgentMailMessage) => void;
type UpdateStatusFn = (ctx: ExtensionContext) => void;

export interface CrewActionConfig {
  stuckThreshold?: number;
  crewEventsInFeed?: boolean;
  nameTheme?: NameThemeConfig;
  feedRetention?: number;
}

export async function executeCrewAction(
  action: string,
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  deliverMessage: DeliverFn,
  updateStatus: UpdateStatusFn,
  _appendEntry: AppendEntryFn,
  _config?: CrewActionConfig,
  _signal?: AbortSignal,
) {
  const dotIndex = action.indexOf(".");
  const group = dotIndex > 0 ? action.slice(0, dotIndex) : action;
  const op = dotIndex > 0 ? action.slice(dotIndex + 1) : null;
  const cwd = ctx.cwd ?? process.cwd();

  if (group === "join") {
    return handlers.executeJoin(state, dirs, ctx, deliverMessage, updateStatus, params.spec, _config?.nameTheme, _config?.feedRetention);
  }

  if (group === "autoRegisterPath") {
    if (!params.autoRegisterPath) {
      return result("Error: autoRegisterPath requires value ('add', 'remove', or 'list').", {
        mode: "autoRegisterPath",
        error: "missing_value",
      });
    }
    return handlers.executeAutoRegisterPath(params.autoRegisterPath);
  }

  if (!state.registered) {
    return handlers.notRegisteredError();
  }

  switch (group) {
    case "status":
      return handlers.executeStatus(state, dirs, cwd);

    case "list":
      return handlers.executeList(state, dirs, cwd, { stuckThreshold: _config?.stuckThreshold });

    case "whois": {
      if (!params.name) {
        return result("Error: name required for whois action.", { mode: "whois", error: "missing_name" });
      }
      return handlers.executeWhois(state, dirs, cwd, params.name, { stuckThreshold: _config?.stuckThreshold });
    }

    case "set_status":
      return handlers.executeSetStatus(state, dirs, ctx, params.message);

    case "feed":
      return handlers.executeFeed(cwd, params.limit, _config?.crewEventsInFeed ?? true);

    case "send":
      return handlers.executeSend(state, dirs, cwd, params.to, false, params.message, params.replyTo);

    case "broadcast":
      return handlers.executeSend(state, dirs, cwd, undefined, true, params.message, params.replyTo);

    case "reserve":
      if (!params.paths || params.paths.length === 0) {
        return result("Error: paths required for reserve action.", { mode: "reserve", error: "missing_paths" });
      }
      return handlers.executeReserve(state, dirs, ctx, params.paths, params.reason);

    case "release":
      return handlers.executeRelease(state, dirs, ctx, params.paths ?? true);

    case "rename":
      if (!params.name) {
        return result("Error: name required for rename action.", { mode: "rename", error: "missing_name" });
      }
      return handlers.executeRename(state, dirs, ctx, params.name, deliverMessage, updateStatus);

    case "swarm":
      return executeSwarmStatus(cwd);

    case "task": {
      const operation = op ?? "list";
      return executeTask(operation, params, state, cwd);
    }

    // Backward-compatible aliases for older swarm calls
    case "claim": {
      const taskId = params.taskId ?? params.id;
      if (!taskId) {
        return result("Error: id or taskId required for claim action.", { mode: "claim", error: "missing_task_id" });
      }
      return executeTask("claim", { ...params, id: taskId }, state, cwd);
    }

    case "unclaim": {
      const taskId = params.taskId ?? params.id;
      if (!taskId) {
        return result("Error: id or taskId required for unclaim action.", { mode: "unclaim", error: "missing_task_id" });
      }
      return executeTask("unclaim", { ...params, id: taskId }, state, cwd);
    }

    case "complete": {
      const taskId = params.taskId ?? params.id;
      if (!taskId) {
        return result("Error: id or taskId required for complete action.", { mode: "complete", error: "missing_task_id" });
      }
      return executeTask("done", { ...params, id: taskId }, state, cwd);
    }

    case "spawn":
      return executeSpawn(op, params, state, cwd);

    // Legacy crew orchestration actions are intentionally disabled in swarm mode.
    case "plan":
    case "work":
    case "review":
    case "sync":
    case "crew":
      return result(
        `Legacy crew action "${action}" is disabled in swarm mode.\n\nUse:\n- pi_messenger({ action: "task.create", ... })\n- pi_messenger({ action: "task.claim", id: "task-N" })\n- pi_messenger({ action: "spawn", role: "...", message: "..." })\n- pi_messenger({ action: "swarm" })`,
        {
          mode: "legacy_disabled",
          action,
        },
      );

    default:
      return result(`Unknown action: ${action}`, { mode: "error", error: "unknown_action", action });
  }
}
