/**
 * Pi Messenger - Feed Scroll Logic
 *
 * This module provides line-based scroll behavior for the activity feed.
 * The scroll position is tracked as an offset into *rendered lines*, not event indices.
 * This ensures j/k scroll by screen lines, and the view stays locked to what the user
 * was reading when new events arrive.
 */

import type { FeedEvent } from "./feed.js";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { renderFeedSection } from "./overlay-render.js";
import {
  type FeedScrollState,
  isAtBottom as isAtBottomCore,
  scrollUp,
  scrollDown,
  jumpToBottom,
  jumpToTop,
  maintainScrollOnNewEvents,
  calculateWindowForOlderLoad,
  initializeScrollState,
  calculateVisibleRangeFromLines,
} from "./feed-scroll-core.js";

// Re-export core functions and types
export {
  type FeedScrollState,
  scrollUp,
  scrollDown,
  jumpToBottom,
  jumpToTop,
  maintainScrollOnNewEvents,
  calculateWindowForOlderLoad,
  initializeScrollState,
  calculateVisibleRangeFromLines,
};

// Re-export isAtBottom with the same signature for compatibility
export function isAtBottom(
  lineScrollOffset: number,
  totalRenderedLines: number,
  feedHeight: number
): boolean {
  return isAtBottomCore(lineScrollOffset, totalRenderedLines, feedHeight);
}

export interface VisibleRange {
  /** Events to render */
  events: FeedEvent[];
  /** Start index in the loaded events array */
  arrayStart: number;
  /** End index in the loaded events array */
  arrayEnd: number;
  /** Whether we need to load older events */
  needsOlderLoad: boolean;
  /** Whether we need to load newer events */
  needsNewerLoad: boolean;
}

/**
 * Calculate all rendered lines for the loaded events.
 * Returns the array of rendered lines and a map from screen line index to event index.
 */
export function calculateRenderedLines(
  events: FeedEvent[],
  theme: Theme,
  width: number,
  lastSeenTs: string | null,
  expanded: boolean
): { lines: string[]; eventIndexMap: number[] } {
  const lines = renderFeedSection(theme, events, width, lastSeenTs, expanded);
  
  // Build a map from each screen line to which event it belongs to
  const eventIndexMap: number[] = [];
  let currentLine = 0;
  
  for (let i = 0; i < events.length; i++) {
    // Render just this event to count its lines
    const eventLines = renderFeedSection(theme, [events[i]], width, lastSeenTs, expanded);
    for (let j = 0; j < eventLines.length; j++) {
      eventIndexMap[currentLine + j] = i;
    }
    currentLine += eventLines.length;
  }
  
  return { lines, eventIndexMap };
}

/**
 * Calculate which events to show based on line-based scroll offset.
 * 
 * lineScrollOffset: number of lines from bottom (0 = at bottom)
 * feedHeight: number of lines visible in viewport
 */
export function calculateVisibleRange(
  loadedEvents: FeedEvent[],
  theme: Theme,
  width: number,
  lastSeenTs: string | null,
  expanded: boolean,
  lineScrollOffset: number,
  feedHeight: number,
  windowStart: number,
  totalLines: number
): VisibleRange & { 
  visibleLines: string[];
  totalRenderedLines: number;
  lineScrollOffset: number; // clamped value
  firstVisibleEventIndex: number;
  lastVisibleEventIndex: number;
} {
  if (loadedEvents.length === 0 || feedHeight <= 0) {
    return {
      events: [],
      arrayStart: 0,
      arrayEnd: 0,
      visibleLines: [],
      totalRenderedLines: 0,
      lineScrollOffset: 0,
      needsOlderLoad: false,
      needsNewerLoad: false,
      firstVisibleEventIndex: 0,
      lastVisibleEventIndex: 0,
    };
  }

  // Calculate all rendered lines
  const { lines, eventIndexMap } = calculateRenderedLines(loadedEvents, theme, width, lastSeenTs, expanded);
  
  if (lines.length === 0) {
    return {
      events: [],
      arrayStart: 0,
      arrayEnd: 0,
      visibleLines: [],
      totalRenderedLines: 0,
      lineScrollOffset: 0,
      needsOlderLoad: false,
      needsNewerLoad: false,
      firstVisibleEventIndex: 0,
      lastVisibleEventIndex: 0,
    };
  }

  // Use the core function to calculate visible range
  const rangeResult = calculateVisibleRangeFromLines(
    lines,
    lineScrollOffset,
    feedHeight,
    windowStart,
    totalLines
  );

  // Map back to event indices for the visible range
  const lineStart = lines.length - rangeResult.lineScrollOffset - rangeResult.visibleLines.length;
  const lineEnd = lineStart + rangeResult.visibleLines.length;
  
  const firstVisibleEventIndex = eventIndexMap[Math.max(0, lineStart)] ?? 0;
  const lastVisibleEventIndex = eventIndexMap[Math.min(lineEnd - 1, lines.length - 1)] ?? (loadedEvents.length - 1);
  
  return {
    events: loadedEvents.slice(firstVisibleEventIndex, lastVisibleEventIndex + 1),
    arrayStart: firstVisibleEventIndex,
    arrayEnd: lastVisibleEventIndex + 1,
    visibleLines: rangeResult.visibleLines,
    totalRenderedLines: lines.length,
    lineScrollOffset: rangeResult.lineScrollOffset,
    needsOlderLoad: rangeResult.needsOlderLoad,
    needsNewerLoad: rangeResult.needsNewerLoad,
    firstVisibleEventIndex,
    lastVisibleEventIndex,
  };
}
