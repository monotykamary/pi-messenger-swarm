import { describe, expect, it } from 'vitest';
import { generateSwarmSnapshot } from '../../overlay/snapshot.js';
import * as taskStore from '../../swarm/task-store.js';
import { logFeedEvent } from '../../feed/index.js';
import { createMessengerFixture, createState } from '../helpers/messenger-fixtures.js';

const TEST_SESSION = 'test-session-snapshot';

describe('swarm overlay snapshot', () => {
  it('summarizes task buckets and recent feed activity', () => {
    const { cwd } = createMessengerFixture('pi-messenger-snapshot-');
    const state = createState('Lead', {
      registered: true,
      currentChannel: 'general',
      sessionStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      activity: { lastActivityAt: new Date(Date.now() - 90_000).toISOString() },
      contextSessionId: TEST_SESSION,
    });

    const done = taskStore.createTask(cwd, TEST_SESSION, { title: 'Done task' }, 'general');
    taskStore.claimTask(cwd, TEST_SESSION, done.id, 'Lead');
    taskStore.completeTask(cwd, TEST_SESSION, done.id, 'Lead', 'finished');

    const claimed = taskStore.createTask(cwd, TEST_SESSION, { title: 'Claimed task' }, 'general');
    taskStore.claimTask(cwd, TEST_SESSION, claimed.id, 'Worker');

    const blocked = taskStore.createTask(cwd, TEST_SESSION, { title: 'Blocked task' }, 'general');
    taskStore.blockTask(cwd, TEST_SESSION, blocked.id, 'Worker', 'waiting on API');

    const root = taskStore.createTask(cwd, TEST_SESSION, { title: 'Root task' }, 'general');
    const waiting = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Waiting task', dependsOn: [root.id] },
      'general'
    );
    const ready = taskStore.createTask(cwd, TEST_SESSION, { title: 'Ready task' }, 'general');

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
      contextSessionId: TEST_SESSION,
    });

    const snapshot = generateSwarmSnapshot(cwd, 'general', state);
    expect(snapshot).toContain('Swarm snapshot: no tasks');
    expect(snapshot).toContain('Create task:');
  });
});
