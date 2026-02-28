/**
 * Type declarations for Explicit Resource Management (TC39 proposal).
 * 
 * TypeScript 5.2+ supports `await using` via the AsyncDisposable interface.
 * This declaration file ensures compatibility.
 */

declare global {
  interface SymbolConstructor {
    readonly dispose: unique symbol;
    readonly asyncDispose: unique symbol;
  }
}

// Make this a module
declare module "./lock.js" {
  export interface AsyncDisposable {
    [Symbol.asyncDispose](): Promise<void>;
  }
}

export {};
