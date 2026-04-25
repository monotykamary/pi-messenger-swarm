// Re-export — module moved to feed/scroll-core.ts
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
  calculateVisibleRangeFromLines,
} from './feed/scroll-core.js';
