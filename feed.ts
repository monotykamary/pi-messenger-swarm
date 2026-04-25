// Re-export — modules moved to feed/ directory
export {
  type FeedEventType,
  type FeedEvent,
  sanitizeFeedEvent,
  appendFeedEvent,
  readFeedEvents,
  readFeedEventsWithOffset,
  readFeedEventsByRange,
  getFeedLineCount,
  pruneFeed,
  formatFeedLine,
  isSwarmEvent,
  logFeedEvent,
} from './feed/index.js';
