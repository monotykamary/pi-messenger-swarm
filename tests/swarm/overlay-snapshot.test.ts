import { describe, expect, it } from 'vitest';
import { generateSwarmSnapshot } from '../../overlay/snapshot.js';
import * as swarmStore from '../../swarm/store.js';
import { logFeedEvent } from '../../feed.js';
import { createMessengerFixture, createState } from '../helpers/messenger-fixtures.js';

describe('swarm overlay snapshot', () => {
  it('summarizes task buckets and recent feed activity', () => {
    const { cwd } = createMessengerFixture('pi-messenger-snapshot-');
    const state = createState('Lead', {
      registered: true,
      currentChannel: 'general',
      sessionStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      activity: { lastActivityAt: new Date(Date.now() - 90_000).toISOString() },
    });

    const done = swarmStore.createTask(cwd, { title: 'Done task' }, 'general');
    swarmStore.claimTask(cwd, done.id, 'Lead', undefined, 'general');
    swarmStore.completeTask(cwd, done.id, 'Lead', 'finished', undefined, 'general');

    const claimed = swarmStore.createTask(cwd, { title: 'Claimed task' }, 'general');
    swarmStore.claimTask(cwd, claimed.id, 'Worker', undefined, 'general');

    const blocked = swarmStore.createTask(cwd, { title: 'Blocked task' }, 'general');
    swarmStore.blockTask(cwd, blocked.id, 'Worker', 'waiting on API', 'general');

    const root = swarmStore.createTask(cwd, { title: 'Root task' }, 'general');
    const waiting = swarmStore.createTask(
      cwd,
      { title: 'Waiting task', dependsOn: [root.id] },
      'general'
    );
    const ready = swarmStore.createTask(cwd, { title: 'Ready task' }, 'general');

    logFeedEvent(cwd, 'Worker', 'task.start', claimed.id, claimed.title, 'general');
    logFeedEvent(cwd, 'Worker', 'message', undefined, 'Snapshot me', 'general');

    const snapshot = generateSwarmSnapshot(cwd, 'general', state);

    expect(snapshot).toContain('Swarm snapshot: 1/6 tasks done, 2 ready');
    expect(snapshot).toContain(`Done: ${done.id} (Done task)`);
    expect(snapshot).toContain(`In progress: ${claimed.id} (Claimed task, Worker)`);
    expect(snapshot).toContain(`Blocked: ${blocked.id} (Blocked task — waiting on API)`);
    expect(snapshot).toContain(`${ready.id} (Ready task)`);
    expect(snapshot).toContain(`Waiting: ${waiting.id} (Waiting task, deps: ${root.id})`);
    expect(snapshot).toContain('Recent:');
  });

  it('renders the no-task empty snapshot state', () => {
    const { cwd } = createMessengerFixture('pi-messenger-snapshot-empty-');
    const state = createState('Lead', {
      registered: true,
      currentChannel: 'general',
      sessionStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      activity: { lastActivityAt: new Date(Date.now() - 90_000).toISOString() },
    });

    const snapshot = generateSwarmSnapshot(cwd, 'general', state);
    expect(snapshot).toContain('Swarm snapshot: no tasks');
    expect(snapshot).toContain('Create task:');
  });
});
