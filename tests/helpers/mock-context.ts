import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { vi } from "vitest";

export function createMockContext(cwd: string = process.cwd()): ExtensionContext {
  return {
    hasUI: true,
    cwd,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn(),
    } as ExtensionContext["ui"],
    sessionManager: {
      getEntries: () => [],
    } as ExtensionContext["sessionManager"],
    model: "test-model",
  } as unknown as ExtensionContext;
}
