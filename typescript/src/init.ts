import { configure, getConfig, requireApiKey, type Config } from "./config.js";
import { TraceRecorder, drainSharedTransportOnExit } from "./recorder.js";
import { onProcessExit } from "./transport.js";
import { TraceStatus } from "./trace.js";

let ambient: TraceRecorder | null = null;
let exitHooked = false;

export interface InitOptions extends Partial<Config> {
  /** Name for the auto-started ambient trace. Defaults to RETRACE_TRACE_NAME, the entry script name, or "agent". */
  name?: string;
  metadata?: Record<string, unknown>;
  /** Auto-start an ambient trace that captures every provider call (default true). Set false to only configure + patch. */
  autoTrace?: boolean;
}

function defaultName(explicit?: string): string {
  if (explicit) return explicit;
  if (typeof process !== "undefined") {
    if (process.env.RETRACE_TRACE_NAME) return process.env.RETRACE_TRACE_NAME;
    const argv1 = process.argv?.[1];
    if (argv1) {
      const base = argv1.split(/[\\/]/).pop();
      if (base) return base.replace(/\.[cm]?[jt]s$/, "");
    }
  }
  return "agent";
}

/**
 * Zero-config, one-line init. Reads `RETRACE_API_KEY` from the environment (or pass `apiKey`),
 * auto-patches any installed provider SDK (OpenAI / Anthropic / Gemini), and auto-starts an
 * ambient trace so every LLM + tool call is captured with NO `startSpan`/`trace()` boilerplate.
 * The ambient trace is flushed and ended automatically on process exit.
 *
 * ```ts
 * import { init } from "retrace-sdk";
 * init();                       // RETRACE_API_KEY from env
 * // ...use openai / anthropic / gemini normally — auto-recorded
 * ```
 *
 * Intended for scripts and single-run agents. Long-lived servers should keep using `trace()`
 * per request so each request is its own trace.
 */
export function init(opts: InitOptions = {}): TraceRecorder | null {
  const { name, metadata, autoTrace = true, ...cfg } = opts;
  configure(cfg);
  requireApiKey();
  if (!getConfig().enabled || !autoTrace) return null;
  if (ambient) return ambient;

  const traceName = defaultName(name);
  ambient = new TraceRecorder({ name: traceName, metadata });
  ambient.start(traceName); // installs the provider interceptors against the ambient recorder

  if (!exitHooked && typeof process !== "undefined") {
    exitHooked = true;
    const finish = (status: TraceStatus, terminatedEarly = false) => {
      const rec = ambient;
      ambient = null;
      try { rec?.end(undefined, status, { terminatedEarly }); } catch { /* best effort on shutdown */ }
    };
    // Finish the ambient trace as a pre-exit hook: registerProcessExitFlush (in recorder.ts) runs
    // this BEFORE draining the transport, so the final trace_ended is in the buffer for the
    // HTTP one-shot — and signal ownership (sole-listener-flush-then-exit vs user-owns-exit) is
    // handled there in one place, not duplicated here.
    //
    // Only a graceful exit (event loop emptied = the program finished its work) produces a CLEAN
    // terminal. Signal/uncaught exits interrupted the run mid-flight, so the synthesized terminal
    // is marked terminated_early — otherwise we'd manufacture a clean-looking terminal for a
    // truncated run and defeat the replay-guard's no-terminal rule.
    onProcessExit((reason) =>
      finish(reason === "uncaught" ? TraceStatus.FAILED : TraceStatus.COMPLETED, reason !== "graceful"),
    );
    // uncaughtException is not covered by registerProcessExitFlush (it's status-specific and must
    // exit non-zero): finish FAILED + terminated_early, drain best-effort within a hard cap, then exit.
    process.once("uncaughtException", (err) => {
      console.error(err);
      finish(TraceStatus.FAILED, true);
      void Promise.race([
        drainSharedTransportOnExit(1500).catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]).then(() => process.exit(1));
    });
  }
  return ambient;
}

/** The ambient recorder started by {@link init}, if any. */
export function getActiveRecorder(): TraceRecorder | null {
  return ambient;
}

/** Manually end the ambient trace (e.g. with a final output) before process exit. Idempotent. */
export function shutdown(output?: unknown, status: TraceStatus = TraceStatus.COMPLETED): void {
  const rec = ambient;
  ambient = null;
  rec?.end(output, status);
}
