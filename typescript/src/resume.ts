/**
 * Full cascade replay for Retrace TypeScript SDK.
 *
 * When trace({ resumable: true }) is used, the SDK:
 * 1. Stores the function reference
 * 2. Listens for 'resume' commands on WebSocket
 * 3. Re-executes the function with modified input
 * 4. Streams new spans back
 */

export interface ResumeCommand {
  forkId: string;
  traceId: string;
  traceName: string;
  forkPointSpanId: string;
  /** 0-based ordinal of the fork-point span among the original ordered spans. Pre-fork spans
   *  (counter <= index) are suppressed on re-exec; the server already has them. */
  forkPointIndex?: number;
  modifiedInput: unknown;
  originalArgs?: unknown[];
}

// Registry of resumable functions
const resumableFunctions = new Map<string, (...args: unknown[]) => unknown>();

export function registerResumable(name: string, fn: (...args: unknown[]) => unknown): void {
  resumableFunctions.set(name, fn);
}

export function getResumable(name: string): ((...args: unknown[]) => unknown) | undefined {
  return resumableFunctions.get(name);
}

export async function handleResume(command: ResumeCommand): Promise<boolean> {
  const fn = getResumable(command.traceName);
  if (!fn) return false;

  try {
    const { TraceRecorder } = await import("./recorder.js");
    const { TraceStatus } = await import("./trace.js");

    const recorder = new TraceRecorder({
      name: `Fork: ${command.traceName}`,
      input: command.modifiedInput,
      metadata: {
        _fork_id: command.forkId,
        _fork_of: command.traceId,
        _fork_point: command.forkPointSpanId,
        _cascade_replay: true,
      },
      forkPointSpanId: command.forkPointSpanId,
      forkPointIndex: command.forkPointIndex,
    });
    recorder.start(`Fork: ${command.traceName}`, command.modifiedInput);

    // Determine args for re-execution
    let args: unknown[] = command.originalArgs || [];
    if (typeof command.modifiedInput === "string") {
      args = [command.modifiedInput, ...args.slice(1)];
    } else if (typeof command.modifiedInput === "object" && !Array.isArray(command.modifiedInput)) {
      args = [command.modifiedInput];
    }

    const result = await Promise.resolve(fn(...args));
    recorder.end(result, TraceStatus.COMPLETED);
    return true;
  } catch (err) {
    console.error("[retrace] Cascade replay failed:", err);
    return false;
  }
}

export function parseResumeMessage(msg: { type: string; data?: Record<string, unknown> }): ResumeCommand | null {
  if (msg.type !== "resume" || !msg.data) return null;
  return {
    forkId: msg.data.forkId as string,
    traceId: msg.data.traceId as string,
    traceName: msg.data.traceName as string,
    forkPointSpanId: msg.data.forkPointSpanId as string,
    forkPointIndex: msg.data.forkPointIndex as number | undefined,
    modifiedInput: msg.data.modifiedInput,
    originalArgs: msg.data.originalArgs as unknown[],
  };
}
