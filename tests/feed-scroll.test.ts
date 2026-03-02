import { beforeEach, describe, expect, it } from "vitest";
import { createTempMessengerDirs } from "./helpers/temp-dirs.js";
import { logFeedEvent, getFeedLineCount } from "../feed.js";
import {
  scrollUp,
  scrollDown,
  jumpToBottom,
  jumpToTop,
  isAtBottom,
  calculateWindowForOlderLoad,
  maintainScrollOnNewEvents,
  type FeedScrollState,
} from "../feed-scroll-core.js";

// Test the line-based scroll functions without rendering dependency
describe("feed-scroll line-based", () => {
  let cwd: string;

  beforeEach(() => {
    const dirs = createTempMessengerDirs();
    cwd = dirs.cwd;
  });

  describe("Line-based scrolling", () => {
    it("scrollUp increases offset toward older content", () => {
      const offset = scrollUp(0, 100, 10, 1);
      expect(offset).toBe(1);

      const offset5 = scrollUp(0, 100, 10, 5);
      expect(offset5).toBe(5);
    });

    it("scrollUp clamps at max valid offset", () => {
      // 100 lines, 10 height = max offset 90
      const offset = scrollUp(85, 100, 10, 10);
      expect(offset).toBe(90); // clamped to max
    });

    it("scrollDown decreases offset toward newer content", () => {
      const offset = scrollDown(10, 1);
      expect(offset).toBe(9);

      const offset5 = scrollDown(10, 5);
      expect(offset5).toBe(5);
    });

    it("scrollDown clamps at 0 (bottom)", () => {
      const offset = scrollDown(3, 5);
      expect(offset).toBe(0); // clamped
    });

    it("jumpToBottom returns 0", () => {
      expect(jumpToBottom()).toBe(0);
    });

    it("jumpToTop returns max valid offset", () => {
      // 100 lines, 10 height = max offset 90
      expect(jumpToTop(100, 10)).toBe(90);

      // Fewer lines than height = 0
      expect(jumpToTop(5, 10)).toBe(0);
    });
  });

  describe("isAtBottom detection", () => {
    it("returns true when offset is 0", () => {
      expect(isAtBottom(0, 100, 10)).toBe(true);
    });

    it("returns false when offset > 0", () => {
      expect(isAtBottom(1, 100, 10)).toBe(false);
      expect(isAtBottom(10, 100, 10)).toBe(false);
    });

    it("returns true when all content fits (total <= height)", () => {
      expect(isAtBottom(0, 5, 10)).toBe(true);
    });
  });

  describe("Window loading calculations", () => {
    it("calculates window for older load", () => {
      const result = calculateWindowForOlderLoad(100, 200, 50, 200, 500);
      expect(result.newWindowStart).toBe(50); // 100 - 50
      expect(result.newWindowEnd).toBe(200); // unchanged, fits in window size
    });

    it("trims window when exceeding max size", () => {
      // Loading 100 more would make 300 total, max is 200
      const result = calculateWindowForOlderLoad(100, 300, 100, 200, 500);
      expect(result.newWindowStart).toBe(0); // 100 - 100, clamped
      expect(result.newWindowEnd).toBe(200); // trimmed to window size
    });

    it("does not go below index 0", () => {
      const result = calculateWindowForOlderLoad(50, 150, 100, 200, 500);
      expect(result.newWindowStart).toBe(0); // clamped
      // Would be 200 but capped by original windowEnd which was 150
      expect(result.newWindowEnd).toBe(150); // unchanged since expanded < windowSize
    });
  });

  describe("Maintaining scroll position on new events", () => {
    it("stays at bottom when wasAtBottom is true", () => {
      const newOffset = maintainScrollOnNewEvents(0, true, 100, 110, 10);
      expect(newOffset).toBe(0);
    });

    it("adjusts offset when scrolled up and new events arrive", () => {
      // Was at offset 20 (viewing older content), 10 new lines added
      const newOffset = maintainScrollOnNewEvents(20, false, 100, 110, 10);
      // Offset increases by lines added to stay looking at same content
      expect(newOffset).toBe(30);
    });

    it("clamps offset when it would exceed max", () => {
      // Was near max offset, many new lines added
      const newOffset = maintainScrollOnNewEvents(85, false, 100, 200, 10);
      // 100 lines -> 200 lines, max offset is now 190
      // 85 + 100 lines added = 185, within bounds
      expect(newOffset).toBe(185); // 85 + (200-100)
    });
  });

  describe("Integration with feed data", () => {
    it("tracks feed line count correctly", () => {
      expect(getFeedLineCount(cwd)).toBe(0);

      logFeedEvent(cwd, "Agent", "join");
      expect(getFeedLineCount(cwd)).toBe(1);

      for (let i = 0; i < 9; i++) {
        logFeedEvent(cwd, "Agent", "message", undefined, `Msg ${i}`);
      }
      expect(getFeedLineCount(cwd)).toBe(10);
    });
  });

  describe("FeedScrollState interface", () => {
    it("can create initial state at bottom", () => {
      const state: FeedScrollState = {
        feedWindowStart: 0,
        feedWindowEnd: 100,
        feedTotalLines: 100,
        lineScrollOffset: 0,
        wasAtBottom: true,
      };

      expect(state.lineScrollOffset).toBe(0);
      expect(isAtBottom(state.lineScrollOffset, 100, 10)).toBe(true);
    });

    it("can create state scrolled up", () => {
      const state: FeedScrollState = {
        feedWindowStart: 0,
        feedWindowEnd: 100,
        feedTotalLines: 100,
        lineScrollOffset: 50,
        wasAtBottom: false,
      };

      expect(state.lineScrollOffset).toBe(50);
      expect(isAtBottom(state.lineScrollOffset, 100, 10)).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("handles empty feed", () => {
      expect(getFeedLineCount(cwd)).toBe(0);
      // With 0 lines, scroll behavior should still work
      expect(scrollUp(0, 0, 10, 1)).toBe(0); // clamped
      expect(scrollDown(0, 1)).toBe(0);
      expect(isAtBottom(0, 0, 10)).toBe(true);
    });

    it("handles rapid scrolling", () => {
      let offset = 0;
      const totalLines = 1000;
      const feedHeight = 10;

      // Rapid scroll up
      for (let i = 0; i < 100; i++) {
        offset = scrollUp(offset, totalLines, feedHeight, 1);
      }
      expect(offset).toBe(100);

      // Rapid scroll down
      for (let i = 0; i < 50; i++) {
        offset = scrollDown(offset, 1);
      }
      expect(offset).toBe(50);
    });

    it("handles window sliding with many new events", () => {
      // Simulating window sliding as user stays at bottom
      let offset = 0;
      let wasAtBottom = true;
      let totalLines = 100;

      // 50 new events arrive while at bottom
      for (let i = 0; i < 50; i++) {
        logFeedEvent(cwd, "Agent", "message", undefined, `New ${i}`);
      }
      const newTotalLines = getFeedLineCount(cwd);
      const linesAdded = newTotalLines - totalLines;

      // Since we were at bottom, offset stays 0
      offset = maintainScrollOnNewEvents(offset, wasAtBottom, totalLines, newTotalLines, 10);
      expect(offset).toBe(0);

      // Now scroll up, then new events arrive
      offset = scrollUp(offset, newTotalLines, 10, 20);
      wasAtBottom = false;

      // 10 more lines added
      const finalTotalLines = newTotalLines + 10;
      offset = maintainScrollOnNewEvents(offset, wasAtBottom, newTotalLines, finalTotalLines, 10);

      // Offset increased by lines added
      expect(offset).toBe(30); // 20 + 10
    });
  });
});
