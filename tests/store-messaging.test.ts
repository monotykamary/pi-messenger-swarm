import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getMyInbox,
  processAllPendingMessages,
  sendMessageToAgent,
  startWatcher,
  stopWatcher,
} from '../store.js';
import { createMessengerFixture, createState } from './helpers/messenger-fixtures.js';

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('store messaging', () => {
  it('writes direct messages into normalized per-channel inboxes', () => {
    const { dirs } = createMessengerFixture('pi-messenger-msg-write-');
    const sender = createState('Sender', { registered: true, currentChannel: 'memory' });

    const msg = sendMessageToAgent(sender, dirs, 'Receiver', 'hello', undefined, '#Memory');
    expect(msg.channel).toBe('memory');

    const inbox = path.join(dirs.inbox, 'Receiver', 'memory');
    const files = fs.readdirSync(inbox);
    expect(files).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(inbox, files[0]), 'utf-8'))).toMatchObject({
      from: 'Sender',
      to: 'Receiver',
      text: 'hello',
      channel: 'memory',
    });
  });

  it('delivers pending messages and clears malformed files', () => {
    const { dirs } = createMessengerFixture('pi-messenger-msg-drain-');
    const receiver = createState('Receiver', { registered: true, currentChannel: 'general' });
    const sender = createState('Sender', { registered: true, currentChannel: 'general' });
    const delivered: string[] = [];

    sendMessageToAgent(sender, dirs, 'Receiver', 'first', undefined, 'general');
    const inbox = getMyInbox(receiver, dirs, 'general');
    fs.writeFileSync(path.join(inbox, 'broken.json'), 'not-json');

    processAllPendingMessages(receiver, dirs, (msg) => delivered.push(msg.text));

    expect(delivered).toEqual(['first']);
    expect(fs.readdirSync(inbox)).toEqual([]);
  });

  it('smoke: watcher receives newly written inbox messages', async () => {
    const { dirs } = createMessengerFixture('pi-messenger-msg-watch-');
    const receiver = createState('Receiver', { registered: true, currentChannel: 'general' });
    const sender = createState('Sender', { registered: true, currentChannel: 'general' });
    const delivered: string[] = [];

    startWatcher(receiver, dirs, (msg) => delivered.push(msg.text));
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      sendMessageToAgent(sender, dirs, 'Receiver', 'watch-me', undefined, 'general');
      await waitFor(() => delivered.includes('watch-me'));
      expect(delivered).toContain('watch-me');
    } finally {
      stopWatcher(receiver);
    }
  });
});
