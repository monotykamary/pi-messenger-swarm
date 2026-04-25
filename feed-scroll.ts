// Re-export — modules moved to feed/ directory
export {
  type FeedScrollState,
  isAtBottom,
  scrollUp,
  scrollDown,
  jumpToBottom,
  jumpToTop,
  maintainScrollOnNewEvents,
  calculateWindowForOlderLoad,
  initializeScrollState,
  calculateRenderedLines,
  calculateVisibleRange,
  calculateVisibleRangeFromLines,
  type VisibleRange,
} from './feed/scroll.js';
