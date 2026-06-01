/**
 * Deterministic Replay with Cassettes for Retrace TypeScript SDK.
 *
 * When the server sends a "replay" command, the SDK:
 * 1. Loads the cassette (recorded span inputs/outputs)
 * 2. Sets up a global cassette store
 * 3. Re-executes the trace function
 * 4. Tool calls are intercepted and return recorded outputs from the cassette
 *
 * This enables one-click reproduction of any production trace locally.
 */

import { getResumable } from "./resume.js";
import { AsyncLocalStorage } from "async_hooks";

export interface CassetteEntry {
  index: number;
  span_type: string;
  name: string;
  model: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
}

export interface ReplayCommand {
  traceId: string;
  traceName: string;
  input: unknown;
  cassette: CassetteEntry[];
}

/** Per-async-context cassette state. Isolates concurrent replays. */
interface CassetteContext {
  cassette: CassetteEntry[];
  pointer: number;
}

const cassetteStorage = new AsyncLocalStorage<CassetteContext>();

/**
 * Check if a replay is currently active in this async context.
 */
export function isReplaying(): boolean {
  return cassetteStorage.getStore() !== undefined;
}

/**
 * Get the next cassette entry matching a span name and type.
 * Uses sequential matching with name-based fallback for deterministic replay.
 * Thread-safe: each async context has its own pointer.
 */
export function consumeCassetteEntry(name: string, spanType: string): CassetteEntry | null {
  const ctx = cassetteStorage.getStore();
  if (!ctx) return null;

  // Primary: sequential pointer (deterministic order)
  if (ctx.pointer < ctx.cassette.length) {
    const entry = ctx.cassette[ctx.pointer];
    if (entry.name === name && entry.span_type === spanType) {
      ctx.pointer++;
      return entry;
    }
  }

  // Fallback: search by name + type from current pointer forward
  for (let i = ctx.pointer; i < ctx.cassette.length; i++) {
    if (ctx.cassette[i].name === name && ctx.cassette[i].span_type === spanType) {
      ctx.pointer = i + 1;
      return ctx.cassette[i];
    }
  }

  return null;
}

/**
 * Handle a replay command from the server.
 * Returns a Promise that resolves when replay completes or rejects on failure.
 * Uses AsyncLocalStorage for per-context cassette isolation.
 */
export async function handleReplay(command: ReplayCommand): Promise<boolean> {
  const fn = getResumable(command.traceName);
  if (!fn) return false;

  return cassetteStorage.run({ cassette: command.cassette, pointer: 0 }, async () => {
    try {
      const { TraceRecorder } = await import("./recorder.js");
      const { TraceStatus } = await import("./trace.js");

      const recorder = new TraceRecorder({
        name: `Replay: ${command.traceName}`,
        input: command.input,
        metadata: {
          _replay_of: command.traceId,
          _deterministic_replay: true,
          _cassette_size: command.cassette.length,
        },
      });
      recorder.start(`Replay: ${command.traceName}`, command.input);

      const args = typeof command.input === "string"
        ? [command.input]
        : Array.isArray(command.input) ? command.input : [command.input];

      const result = await Promise.resolve(fn(...args));
      recorder.end(result, TraceStatus.COMPLETED);
      return true;
    } catch (err) {
      console.error("[retrace] Deterministic replay failed:", err);
      return false;
    }
  });
}

export function parseReplayMessage(msg: { type: string; data?: unknown }): ReplayCommand | null {
  if (msg.type !== "replay" || !msg.data) return null;
  const data = msg.data as Record<string, unknown>;
  return {
    traceId: data.traceId as string,
    traceName: data.traceName as string,
    input: data.input,
    cassette: data.cassette as CassetteEntry[],
  };
}
