/**
 * Pi Messenger - Feed Scroll Core Logic
 *
 * Pure line-based scroll calculations without rendering dependencies.
 * This module can be tested independently.
 */

/**
 * Line-based scroll state interface
 */
export interface FeedScrollState {
  /** Absolute index in feed.jsonl of first loaded event (sparse window) */
  feedWindowStart: number;
  /** Absolute index in feed.jsonl of last loaded event */
  feedWindowEnd: number;
  /** Total lines in feed.jsonl */
  feedTotalLines: number;
  /** 
   * Line-based scroll offset - number of lines from the bottom of the rendered feed.
   * 0 = at bottom (showing newest content)
   * >0 = scrolled up by N screen lines
   */
  lineScrollOffset: number;
  /** Whether we were at bottom before new events arrived (for auto-follow) */
  wasAtBottom: boolean;
}

/**
 * Check if currently at bottom (showing newest content).
 */
export function isAtBottom(
  lineScrollOffset: number,
  totalRenderedLines: number,
  feedHeight: number
): boolean {
  if (totalRenderedLines <= feedHeight) return true;
  return lineScrollOffset <= 0;
}

/**
 * Scroll up by N screen lines (toward older content).
 * Returns new lineScrollOffset.
 */
export function scrollUp(
  currentOffset: number,
  totalRenderedLines: number,
  feedHeight: number,
  lines: number = 1
): number {
  const maxOffset = Math.max(0, totalRenderedLines - feedHeight);
  const newOffset = currentOffset + lines;
  return Math.min(newOffset, maxOffset);
}

/**
 * Scroll down by N screen lines (toward newer content).
 * Returns new lineScrollOffset.
 */
export function scrollDown(
  currentOffset: number,
  lines: number = 1
): number {
  return Math.max(0, currentOffset - lines);
}

/**
 * Jump to bottom (newest content).
 */
export function jumpToBottom(): number {
  return 0;
}

/**
 * Jump to top (oldest content).
 */
export function jumpToTop(
  totalRenderedLines: number,
  feedHeight: number
): number {
  if (totalRenderedLines <= feedHeight) return 0;
  return totalRenderedLines - feedHeight;
}

/**
 * Handle new events arriving.
 * If at bottom, stay at bottom. If scrolled up, maintain scroll position.
 * Returns the adjusted lineScrollOffset.
 */
export function maintainScrollOnNewEvents(
  currentOffset: number,
  wasAtBottom: boolean,
  previousRenderedLines: number,
  newRenderedLines: number,
  feedHeight: number
): number {
  if (wasAtBottom) {
    // Track to new bottom
    return 0;
  }
  
  // Calculate how many new lines were added at the bottom
  const linesAdded = newRenderedLines - previousRenderedLines;
  
  // Adjust offset to maintain visual position
  // If we were at offset X (from old bottom), we need to increase offset by linesAdded
  // to stay looking at the same content
  const newOffset = currentOffset + linesAdded;
  const maxOffset = Math.max(0, newRenderedLines - feedHeight);
  
  return Math.min(newOffset, maxOffset);
}

/**
 * Calculate window adjustment when loading older events.
 */
export function calculateWindowForOlderLoad(
  currentWindowStart: number,
  currentWindowEnd: number,
  loadChunkSize: number,
  windowSize: number,
  totalLines: number
): { newWindowStart: number; newWindowEnd: number } {
  const newStart = Math.max(0, currentWindowStart - loadChunkSize);
  let newEnd = currentWindowEnd;

  // If window would exceed max size, trim from the end (newer side)
  const expandedSize = currentWindowEnd - newStart;
  if (expandedSize > windowSize) {
    newEnd = newStart + windowSize;
  }

  return { newWindowStart: newStart, newWindowEnd: newEnd };
}

/**
 * Initialize scroll state for first render.
 */
export function initializeScrollState(totalLines: number): FeedScrollState {
  return {
    feedWindowStart: Math.max(0, totalLines - 200),
    feedWindowEnd: totalLines,
    feedTotalLines: totalLines,
    lineScrollOffset: 0, // Start at bottom
    wasAtBottom: true,
  };
}

/**
 * Calculate line-based visible range from pre-rendered lines.
 * This is the core logic that doesn't depend on the render function.
 */
export function calculateVisibleRangeFromLines(
  allLines: string[],
  lineScrollOffset: number,
  feedHeight: number,
  windowStart: number,
  totalLines: number
): {
  visibleLines: string[];
  lineScrollOffset: number; // clamped value
  totalRenderedLines: number;
  needsOlderLoad: boolean;
  needsNewerLoad: boolean;
} {
  if (allLines.length === 0 || feedHeight <= 0) {
    return {
      visibleLines: [],
      lineScrollOffset: 0,
      totalRenderedLines: 0,
      needsOlderLoad: false,
      needsNewerLoad: false,
    };
  }

  // Clamp scroll offset to valid range
  const maxOffset = Math.max(0, allLines.length - feedHeight);
  const clampedOffset = Math.max(0, Math.min(lineScrollOffset, maxOffset));
  
  // Calculate visible line range (from bottom up)
  // lineScrollOffset 0 = bottom of lines array
  const lineEnd = allLines.length - clampedOffset;
  const lineStart = Math.max(0, lineEnd - feedHeight);
  
  // Get the slice of visible lines
  const visibleLines = allLines.slice(lineStart, lineEnd);
  
  // Check if we need to load more events
  // Need older if we're showing the first few lines of what's loaded
  const needsOlderLoad = lineStart < 5 && windowStart > 0;
  // Need newer if we're past the end (shouldn't happen normally since we auto-follow)
  const needsNewerLoad = lineEnd > allLines.length && windowStart + allLines.length < totalLines;
  
  return {
    visibleLines,
    lineScrollOffset: clampedOffset,
    totalRenderedLines: allLines.length,
    needsOlderLoad,
    needsNewerLoad,
  };
}
