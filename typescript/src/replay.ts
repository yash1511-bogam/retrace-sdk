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

// Global cassette state for the current replay session
let activeCassette: CassetteEntry[] | null = null;
let cassettePointer = 0;

/**
 * Check if a replay is currently active.
 */
export function isReplaying(): boolean {
  return activeCassette !== null;
}

/**
 * Get the next cassette entry matching a span name and type.
 * Uses sequential matching with name-based fallback for deterministic replay.
 */
export function consumeCassetteEntry(name: string, spanType: string): CassetteEntry | null {
  if (!activeCassette) return null;

  // Primary: sequential pointer (deterministic order)
  if (cassettePointer < activeCassette.length) {
    const entry = activeCassette[cassettePointer];
    if (entry.name === name && entry.span_type === spanType) {
      cassettePointer++;
      return entry;
    }
  }

  // Fallback: search by name + type from current pointer forward
  for (let i = cassettePointer; i < activeCassette.length; i++) {
    if (activeCassette[i].name === name && activeCassette[i].span_type === spanType) {
      cassettePointer = i + 1;
      return activeCassette[i];
    }
  }

  return null;
}

/**
 * Handle a replay command from the server.
 */
export function handleReplay(command: ReplayCommand): boolean {
  const fn = getResumable(command.traceName);
  if (!fn) return false;

  // Set up cassette
  activeCassette = command.cassette;
  cassettePointer = 0;

  (async () => {
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
    } catch (err) {
      console.error("[retrace] Deterministic replay failed:", err);
    } finally {
      // Clean up cassette state
      activeCassette = null;
      cassettePointer = 0;
    }
  })();

  return true;
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
