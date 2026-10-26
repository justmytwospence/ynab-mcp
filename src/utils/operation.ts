import { AsyncLocalStorage } from "node:async_hooks";

interface Operation { attempts: number; warnings: string[]; mutationAttempted: boolean }
const operations = new AsyncLocalStorage<Operation>();

/** Per invocation, not a subtraction of shared counters (other calls may overlap). */
export function runOperation<T>(fn: () => Promise<T>): Promise<T> {
  return operations.run({ attempts: 0, warnings: [], mutationAttempted: false }, fn);
}
export function recordAttempt(method = "GET") {
  const op = operations.getStore();
  if (op) {
    op.attempts++;
    if (!["GET", "HEAD"].includes(method.toUpperCase())) op.mutationAttempted = true;
  }
}
export function mutationAttempted() { return operations.getStore()?.mutationAttempted === true; }
export function operationWarning(message: string) { operations.getStore()?.warnings.push(message); }
export function operationUsage() {
  const op = operations.getStore();
  return { attempts: op?.attempts ?? 0, warnings: [...(op?.warnings ?? [])] };
}
export function inOperation() { return operations.getStore() !== undefined; }
