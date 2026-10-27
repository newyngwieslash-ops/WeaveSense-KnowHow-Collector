import { AsyncLocalStorage } from "node:async_hooks";
import type { Engine } from "./engine.ts";

// Request quarantine must not leak across concurrent requests or disable unrelated RSS material.
const request = new AsyncLocalStorage<{ engine: Engine; allowed: boolean }>();
const readiness = new WeakMap<Engine, boolean>();
export const setVideoAccessReady = (engine: Engine, allowed: boolean) => readiness.set(engine, allowed);
export const videoAccess = (engine: Engine) => request.getStore()?.engine === engine ? request.getStore()!.allowed : readiness.get(engine) ?? true;
export const withVideoAccess = <T>(engine: Engine, allowed: boolean, fn: () => Promise<T>) => request.run({ engine, allowed }, fn);
