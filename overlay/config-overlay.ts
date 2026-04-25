/**
 * Pi Messenger - Config Overlay Component
 */

import type { Component, Focusable, TUI } from '@mariozechner/pi-tui';
import { matchesKey, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import { getAutoRegisterPaths, saveAutoRegisterPaths, matchesAutoRegisterPath } from '../config.js';

export class MessengerConfigOverlay implements Component, Focusable {
  readonly width = 60;
  focused = false;

  private paths: string[];
  private selectedIndex = 0;
  private dirty = false;
  private statusMessage = '';

  constructor(
    private tui: TUI,
    private theme: Theme,
    private done: () => void
  ) {
    this.paths = getAutoRegisterPaths();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      if (this.dirty) {
        saveAutoRegisterPaths(this.paths);
      }
      this.done();
      return;
    }

    if (matchesKey(data, 'a')) {
      this.addCurrentPath();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, 'd') || matchesKey(data, 'backspace')) {
      this.deleteSelected();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, 'up')) {
      if (this.paths.length > 0) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, 'down')) {
      if (this.paths.length > 0) {
        this.selectedIndex = Math.min(this.paths.length - 1, this.selectedIndex + 1);
        this.tui.requestRender();
      }
      return;
    }
  }

  private addCurrentPath(): void {
    const cwd = process.cwd();
    if (this.paths.includes(cwd)) {
      this.statusMessage = 'Already in list';
      return;
    }
    this.paths.push(cwd);
    this.selectedIndex = this.paths.length - 1;
    this.dirty = true;
    this.statusMessage = 'Added current folder';
  }

  private deleteSelected(): void {
    if (this.paths.length === 0) return;

    const removed = this.paths[this.selectedIndex];
    this.paths.splice(this.selectedIndex, 1);
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.paths.length - 1));
    this.dirty = true;
    this.statusMessage = `Removed: ${removed.split('/').pop()}`;
  }

  render(_width: number): string[] {
    const w = this.width;
    const innerW = w - 2;
    const lines: string[] = [];
    const cwd = process.cwd();
    const isCurrentInList = matchesAutoRegisterPath(cwd, this.paths);

    const border = (s: string) => this.theme.fg('dim', s);
    const pad = (s: string, len: number) => s + ' '.repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) => border('│') + pad(' ' + content, innerW) + border('│');
    const emptyRow = () => border('│') + ' '.repeat(innerW) + border('│');

    // Top border with title
    const titleText = ' Messenger Config ';
    const borderLen = innerW - titleText.length;
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;
    lines.push(
      border('╭' + '─'.repeat(leftBorder)) +
        this.theme.fg('accent', titleText) +
        border('─'.repeat(rightBorder) + '╮')
    );

    lines.push(emptyRow());

    // Current folder status
    const cwdDisplay = truncateToWidth(cwd, Math.max(10, innerW - 20));
    lines.push(row(`Current folder: ${cwdDisplay}`));
    const statusColor = isCurrentInList ? 'accent' : 'dim';
    lines.push(row(`Auto-register: ${this.theme.fg(statusColor, isCurrentInList ? 'YES' : 'NO')}`));

    lines.push(emptyRow());

    // Divider
    lines.push(border('├' + '─'.repeat(innerW) + '┤'));

    lines.push(emptyRow());
    lines.push(row(this.theme.fg('dim', 'Auto-register paths:')));
    lines.push(emptyRow());

    if (this.paths.length === 0) {
      lines.push(row(this.theme.fg('dim', '  (none configured)')));
    } else {
      for (let i = 0; i < this.paths.length; i++) {
        const path = this.paths[i];
        const isSelected = i === this.selectedIndex;
        const isCurrent = path === cwd;

        const marker = isSelected ? this.theme.fg('accent', '▸') : ' ';
        const suffix = isCurrent ? this.theme.fg('dim', ' (current)') : '';
        const pathDisplay = truncateToWidth(path, Math.max(10, innerW - 15));

        if (isSelected) {
          lines.push(row(`${marker} ${this.theme.fg('accent', pathDisplay)}${suffix}`));
        } else {
          lines.push(row(`${marker} ${pathDisplay}${suffix}`));
        }
      }
    }

    lines.push(emptyRow());

    // Divider
    lines.push(border('├' + '─'.repeat(innerW) + '┤'));

    lines.push(emptyRow());

    // Status message
    if (this.statusMessage) {
      lines.push(row(this.theme.fg('accent', this.statusMessage)));
    } else {
      lines.push(emptyRow());
    }

    // Help
    const help = 'a add  d delete  ↑↓ navigate  Esc save & close';
    lines.push(row(this.theme.fg('dim', help)));

    // Bottom border
    lines.push(border('╰' + '─'.repeat(innerW) + '╯'));

    return lines;
  }

  invalidate(): void {
    this.statusMessage = '';
  }

  dispose(): void {}
}
