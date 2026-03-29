import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dirs, MessengerState } from '../lib.js';

vi.mock('@mariozechner/pi-tui', () => ({
  truncateToWidth: (text: string, width: number) =>
    text.length > width ? text.slice(0, Math.max(0, width)) : text,
  visibleWidth: (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '').length,
  matchesKey: () => false,
}));

const roots = new Set<string>();
const theme = {
  fg: (_name: string, text: string) => text,
};

function extractVisibleMessages(frame: string[]): string[] {
  const middleBorderIndex = frame.findIndex((line) => line.includes('├') && line.includes('┤'));
  const contentLines = middleBorderIndex >= 0 ? frame.slice(0, middleBorderIndex) : frame;
  const separatorIndexes = contentLines
    .map((line, index) => (/─{5,}/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const lastContentSeparator = separatorIndexes.at(-1);
  const feedLines =
    lastContentSeparator === undefined
      ? contentLines
      : contentLines.slice(lastContentSeparator + 1);

  return feedLines
    .map((line) => line.match(/Msg \d+/)?.[0])
    .filter((value): value is string => Boolean(value));
}

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-overlay-layout-'));
  roots.add(cwd);
  fs.mkdirSync(path.join(cwd, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.pi', 'messenger', 'inbox'), { recursive: true });
  return cwd;
}

function makeDirs(cwd: string): Dirs {
  return {
    base: path.join(cwd, '.pi', 'messenger'),
    registry: path.join(cwd, '.pi', 'messenger', 'registry'),
    inbox: path.join(cwd, '.pi', 'messenger', 'inbox'),
  };
}

function makeState(): MessengerState {
  const now = new Date().toISOString();
  return {
    agentName: 'BenchAgent',
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map([['general', 0]]),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: 'bench',
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: now },
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: now,
    currentChannel: 'general',
    sessionChannel: 'general',
    joinedChannels: ['general'],
  };
}

function setTerminalSize(rows: number, columns: number): () => void {
  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: rows });
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: columns });
  return () => {
    if (rowsDescriptor) Object.defineProperty(process.stdout, 'rows', rowsDescriptor);
    if (columnsDescriptor) Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe('overlay layout', () => {
  it('expands the feed viewport when the task panel uses fewer lines than budgeted', async () => {
    const cwd = createTempCwd();
    const dirs = makeDirs(cwd);
    const state = makeState();
    const restoreTerminal = setTerminalSize(16, 100);
    const previousCwd = process.cwd();
    process.chdir(cwd);

    try {
      const swarmStore = await import('../swarm/store.js');
      const { logFeedEvent } = await import('../feed.js');
      const { MessengerOverlay } = await import('../overlay.js');

      swarmStore.createTask(cwd, {
        title: 'Single visible task',
        createdBy: 'BenchAgent',
      });

      for (let i = 0; i < 10; i++) {
        logFeedEvent(cwd, 'BenchAgent', 'message', undefined, `Msg ${i}`);
      }

      const overlay = new MessengerOverlay(
        { requestRender: () => {} } as any,
        theme as any,
        state,
        dirs,
        () => {},
        {}
      );

      const frame = overlay.render(100);
      overlay.dispose();

      const visibleMessages = extractVisibleMessages(frame);
      expect(visibleMessages).toHaveLength(6);
      expect(visibleMessages.at(-1)).toContain('Msg 9');
    } finally {
      process.chdir(previousCwd);
      restoreTerminal();
    }
  });

  it('keeps the same feed content visible while scrolled up and new events arrive', async () => {
    const cwd = createTempCwd();
    const dirs = makeDirs(cwd);
    const state = makeState();
    const restoreTerminal = setTerminalSize(16, 100);
    const previousCwd = process.cwd();
    process.chdir(cwd);

    try {
      const { logFeedEvent } = await import('../feed.js');
      const { MessengerOverlay } = await import('../overlay.js');

      for (let i = 0; i < 12; i++) {
        logFeedEvent(cwd, 'BenchAgent', 'message', undefined, `Msg ${i}`);
      }

      const overlay = new MessengerOverlay(
        { requestRender: () => {} } as any,
        theme as any,
        state,
        dirs,
        () => {},
        {}
      );

      overlay.render(100);
      overlay.handleInput('k');
      overlay.handleInput('k');
      overlay.handleInput('k');

      const beforeFrame = overlay.render(100);
      const beforeMessages = extractVisibleMessages(beforeFrame);
      expect(beforeMessages.length).toBeGreaterThan(0);
      expect(beforeMessages).not.toContain('Msg 11');

      logFeedEvent(cwd, 'BenchAgent', 'message', undefined, 'Msg 12');
      (overlay as any).feedLineCountCache = null;
      (overlay as any).renderCache = null;

      const afterFrame = overlay.render(100);
      const afterMessages = extractVisibleMessages(afterFrame);

      expect(afterMessages).toEqual(beforeMessages);
      expect(afterMessages).not.toContain('Msg 12');

      overlay.dispose();
    } finally {
      process.chdir(previousCwd);
      restoreTerminal();
    }
  });

  it('initializes the feed window when scrolling before the first render', async () => {
    const cwd = createTempCwd();
    const dirs = makeDirs(cwd);
    const state = makeState();
    const restoreTerminal = setTerminalSize(16, 100);
    const previousCwd = process.cwd();
    process.chdir(cwd);

    try {
      const { logFeedEvent } = await import('../feed.js');
      const { MessengerOverlay } = await import('../overlay.js');

      for (let i = 0; i < 12; i++) {
        logFeedEvent(cwd, 'BenchAgent', 'message', undefined, `Msg ${i}`);
      }

      const overlay = new MessengerOverlay(
        { requestRender: () => {} } as any,
        theme as any,
        state,
        dirs,
        () => {},
        {}
      );

      overlay.handleInput('k');
      const frame = overlay.render(100);
      const visibleMessages = extractVisibleMessages(frame);

      expect((overlay as any).viewState.feedLoadedEvents.length).toBeGreaterThan(0);
      expect(visibleMessages.length).toBeGreaterThan(0);
      expect(visibleMessages).not.toContain('Msg 11');

      overlay.dispose();
    } finally {
      process.chdir(previousCwd);
      restoreTerminal();
    }
  });

  it('returns to the newest feed items with G after scrolling up', async () => {
    const cwd = createTempCwd();
    const dirs = makeDirs(cwd);
    const state = makeState();
    const restoreTerminal = setTerminalSize(16, 100);
    const previousCwd = process.cwd();
    process.chdir(cwd);

    try {
      const { logFeedEvent } = await import('../feed.js');
      const { MessengerOverlay } = await import('../overlay.js');

      for (let i = 0; i < 12; i++) {
        logFeedEvent(cwd, 'BenchAgent', 'message', undefined, `Msg ${i}`);
      }

      const overlay = new MessengerOverlay(
        { requestRender: () => {} } as any,
        theme as any,
        state,
        dirs,
        () => {},
        {}
      );

      overlay.render(100);
      overlay.handleInput('k');
      overlay.handleInput('k');
      overlay.handleInput('k');
      expect(extractVisibleMessages(overlay.render(100))).not.toContain('Msg 11');

      overlay.handleInput('G');
      const frame = overlay.render(100);
      const visibleMessages = extractVisibleMessages(frame);

      expect(visibleMessages).toContain('Msg 11');
      expect((overlay as any).viewState.feedLineScrollOffset).toBe(0);

      overlay.dispose();
    } finally {
      process.chdir(previousCwd);
      restoreTerminal();
    }
  });

  it('refreshes the rendered feed after cache ttl when new events arrive', async () => {
    const cwd = createTempCwd();
    const dirs = makeDirs(cwd);
    const state = makeState();
    const restoreTerminal = setTerminalSize(16, 100);
    const previousCwd = process.cwd();
    process.chdir(cwd);

    try {
      const { logFeedEvent } = await import('../feed.js');
      const { MessengerOverlay } = await import('../overlay.js');

      for (let i = 0; i < 3; i++) {
        logFeedEvent(cwd, 'BenchAgent', 'message', undefined, `Msg ${i}`);
      }

      const overlay = new MessengerOverlay(
        { requestRender: () => {} } as any,
        theme as any,
        state,
        dirs,
        () => {},
        {}
      );

      expect(extractVisibleMessages(overlay.render(100))).toContain('Msg 2');

      logFeedEvent(cwd, 'BenchAgent', 'message', undefined, 'Msg 3');
      await sleep(120);

      const frame = overlay.render(100);
      expect(extractVisibleMessages(frame)).toContain('Msg 3');

      overlay.dispose();
    } finally {
      process.chdir(previousCwd);
      restoreTerminal();
    }
  });
});
