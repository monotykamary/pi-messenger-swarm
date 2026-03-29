import { existsSync } from 'node:fs';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { Dirs, MessengerState, SpecClaims, SpecCompletions } from '../lib.js';
import { displaySpecPath, resolveSpecPath } from '../lib.js';
import * as store from '../store.js';
import { result } from './result.js';

export function executeSetSpec(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  specPath: string
) {
  const absPath = resolveSpecPath(specPath, process.cwd());
  state.spec = absPath;
  store.updateRegistration(state, dirs, ctx);
  const display = displaySpecPath(absPath, process.cwd());
  const warning = existsSync(absPath) ? '' : `\n\nWarning: Spec file not found at ${display}.`;
  return result(`Spec set to ${display}${warning}`, { mode: 'spec', spec: display });
}

export async function executeClaim(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  taskId: string,
  specPath?: string,
  reason?: string
) {
  const spec = specPath ? resolveSpecPath(specPath, process.cwd()) : state.spec;
  if (!spec) {
    return result('Error: No spec registered. Use `spec` parameter or join with a spec first.', {
      mode: 'claim',
      error: 'no_spec',
    });
  }

  const warning =
    specPath && !existsSync(spec)
      ? `\n\nWarning: Spec file not found at ${displaySpecPath(spec, process.cwd())}.`
      : '';

  const claimResult = await store.claimTask(
    dirs,
    spec,
    taskId,
    state.agentName,
    ctx.sessionManager.getSessionId(),
    process.pid,
    reason
  );

  const display = displaySpecPath(spec, process.cwd());
  if (store.isClaimSuccess(claimResult)) {
    return result(`Claimed ${taskId} in ${display}${warning}`, {
      mode: 'claim',
      spec: display,
      taskId,
      claimedAt: claimResult.claimedAt,
      reason,
    });
  }

  if (store.isClaimAlreadyHaveClaim(claimResult)) {
    const existingDisplay = displaySpecPath(claimResult.existing.spec, process.cwd());
    return result(
      `Error: You already have a claim on ${claimResult.existing.taskId} in ${existingDisplay}. Complete or unclaim it first.${warning}`,
      {
        mode: 'claim',
        error: 'already_have_claim',
        existing: { spec: existingDisplay, taskId: claimResult.existing.taskId },
      }
    );
  }

  return result(`Error: ${taskId} is already claimed by ${claimResult.conflict.agent}.${warning}`, {
    mode: 'claim',
    error: 'already_claimed',
    taskId,
    conflict: claimResult.conflict,
  });
}

export async function executeUnclaim(
  state: MessengerState,
  dirs: Dirs,
  taskId: string,
  specPath?: string
) {
  const spec = specPath ? resolveSpecPath(specPath, process.cwd()) : state.spec;
  if (!spec) {
    return result('Error: No spec registered.', { mode: 'unclaim', error: 'no_spec' });
  }

  const warning =
    specPath && !existsSync(spec)
      ? `\n\nWarning: Spec file not found at ${displaySpecPath(spec, process.cwd())}.`
      : '';

  const unclaimResult = await store.unclaimTask(dirs, spec, taskId, state.agentName);
  const display = displaySpecPath(spec, process.cwd());

  if (store.isUnclaimSuccess(unclaimResult)) {
    return result(`Released claim on ${taskId}${warning}`, {
      mode: 'unclaim',
      spec: display,
      taskId,
    });
  }

  if (store.isUnclaimNotYours(unclaimResult)) {
    return result(`Error: ${taskId} is claimed by ${unclaimResult.claimedBy}, not you.${warning}`, {
      mode: 'unclaim',
      error: 'not_your_claim',
      taskId,
      claimedBy: unclaimResult.claimedBy,
    });
  }

  return result(`Error: ${taskId} is not claimed.${warning}`, {
    mode: 'unclaim',
    error: 'not_claimed',
    taskId,
  });
}

export async function executeComplete(
  state: MessengerState,
  dirs: Dirs,
  taskId: string,
  notes?: string,
  specPath?: string
) {
  const spec = specPath ? resolveSpecPath(specPath, process.cwd()) : state.spec;
  if (!spec) {
    return result('Error: No spec registered.', { mode: 'complete', error: 'no_spec' });
  }

  const warning =
    specPath && !existsSync(spec)
      ? `\n\nWarning: Spec file not found at ${displaySpecPath(spec, process.cwd())}.`
      : '';

  const completeResult = await store.completeTask(dirs, spec, taskId, state.agentName, notes);
  const display = displaySpecPath(spec, process.cwd());

  if (store.isCompleteSuccess(completeResult)) {
    return result(`Completed ${taskId} in ${display}${warning}`, {
      mode: 'complete',
      spec: display,
      taskId,
      completedAt: completeResult.completedAt,
    });
  }

  if (store.isCompleteAlreadyCompleted(completeResult)) {
    return result(
      `Error: ${taskId} was already completed by ${completeResult.completion.completedBy}.${warning}`,
      {
        mode: 'complete',
        error: 'already_completed',
        taskId,
        completion: completeResult.completion,
      }
    );
  }

  if (store.isCompleteNotYours(completeResult)) {
    return result(
      `Error: ${taskId} is claimed by ${completeResult.claimedBy}, not you.${warning}`,
      {
        mode: 'complete',
        error: 'not_your_claim',
        taskId,
        claimedBy: completeResult.claimedBy,
      }
    );
  }

  return result(`Error: ${taskId} is not claimed.${warning}`, {
    mode: 'complete',
    error: 'not_claimed',
    taskId,
  });
}

export function executeSwarm(state: MessengerState, dirs: Dirs, specPath?: string) {
  const claims = store.getClaims(dirs);
  const completions = store.getCompletions(dirs);
  const agents = store.getActiveAgents(state, dirs);
  const cwd = process.cwd();

  const absByDisplay = new Map<string, string>();
  const addAbs = (abs: string) => {
    const display = displaySpecPath(abs, cwd);
    if (!absByDisplay.has(display)) absByDisplay.set(display, abs);
  };

  for (const abs of Object.keys(claims)) addAbs(abs);
  for (const abs of Object.keys(completions)) addAbs(abs);
  if (state.spec) addAbs(state.spec);
  for (const agent of agents) {
    if (agent.spec) addAbs(agent.spec);
  }

  const specAgents: Record<string, string[]> = {};
  if (state.spec) {
    const display = displaySpecPath(state.spec, cwd);
    specAgents[display] = [state.agentName];
  }
  for (const agent of agents) {
    if (!agent.spec) continue;
    const display = displaySpecPath(agent.spec, cwd);
    if (!specAgents[display]) specAgents[display] = [];
    specAgents[display].push(agent.name);
  }

  const myClaim = store.getAgentCurrentClaim(dirs, state.agentName);
  const mySpec = state.spec ? displaySpecPath(state.spec, cwd) : undefined;

  if (specPath) {
    const absSpec = resolveSpecPath(specPath, cwd);
    const display = displaySpecPath(absSpec, cwd);
    const warning = !existsSync(absSpec) ? `\n\nWarning: Spec file not found at ${display}.` : '';
    const specClaims: SpecClaims = claims[absSpec] || {};
    const specCompletions: SpecCompletions = completions[absSpec] || {};
    const specAgentList = specAgents[display] || [];

    const lines = [`Swarm: ${display}`, ''];
    const completedIds = Object.keys(specCompletions);
    lines.push(`Completed: ${completedIds.length > 0 ? completedIds.join(', ') : '(none)'}`);

    const inProgress = Object.entries(specClaims).map(
      ([tid, c]) => `${tid} (${c.agent === state.agentName ? 'you' : c.agent})`
    );
    lines.push(`In progress: ${inProgress.length > 0 ? inProgress.join(', ') : '(none)'}`);

    const teammates = specAgentList.filter((name) => name !== state.agentName);
    if (teammates.length > 0) lines.push(`Teammates: ${teammates.join(', ')}`);

    return result(lines.join('\n') + warning, {
      mode: 'swarm',
      spec: display,
      agents: specAgentList,
      claims: specClaims,
      completions: specCompletions,
    });
  }

  const allSpecs = new Set<string>([...absByDisplay.keys(), ...Object.keys(specAgents)]);

  const lines = ['Swarm Status:', ''];
  const specsData: Record<
    string,
    { agents: string[]; claims: SpecClaims; completions: SpecCompletions }
  > = {};

  for (const display of Array.from(allSpecs).sort((a, b) => a.localeCompare(b))) {
    const absSpec = absByDisplay.get(display) ?? resolveSpecPath(display, cwd);
    const specClaims: SpecClaims = claims[absSpec] || {};
    const specCompletions: SpecCompletions = completions[absSpec] || {};
    const specAgentList = specAgents[display] || [];

    specsData[display] = {
      agents: specAgentList,
      claims: specClaims,
      completions: specCompletions,
    };

    const isMySpec = display === mySpec;
    lines.push(`${display}${isMySpec ? ' (your spec)' : ''}:`);

    const completedIds = Object.keys(specCompletions);
    lines.push(`  Completed: ${completedIds.length > 0 ? completedIds.join(', ') : '(none)'}`);

    const inProgress = Object.entries(specClaims).map(
      ([tid, c]) => `${tid} (${c.agent === state.agentName ? 'you' : c.agent})`
    );
    lines.push(`  In progress: ${inProgress.length > 0 ? inProgress.join(', ') : '(none)'}`);

    const idle = specAgentList.filter(
      (name) => !Object.values(specClaims).some((c) => c.agent === name)
    );
    if (idle.length > 0) lines.push(`  Idle: ${idle.join(', ')}`);
    lines.push('');
  }

  return result(lines.join('\n').trim(), {
    mode: 'swarm',
    yourSpec: mySpec,
    yourClaim: myClaim?.taskId,
    specs: specsData,
  });
}
