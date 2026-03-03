import { AsyncLocalStorage } from "node:async_hooks";

const figmaAccessGuard = new AsyncLocalStorage<{ blocked: boolean; source: string }>();

export class FigmaAccessForbiddenError extends Error {
  readonly source: string;

  constructor(source: string) {
    super(`Figma access is forbidden in ${source}`);
    this.name = "FigmaAccessForbiddenError";
    this.source = source;
  }
}

export function runWithFigmaAccessBlocked<T>(source: string, fn: () => Promise<T>): Promise<T> {
  return figmaAccessGuard.run({ blocked: true, source }, fn);
}

export function assertFigmaAccessAllowed() {
  const context = figmaAccessGuard.getStore();
  if (context?.blocked) {
    throw new FigmaAccessForbiddenError(context.source);
  }
}
