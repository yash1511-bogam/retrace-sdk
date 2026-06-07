export interface Config {
  apiKey: string;
  baseUrl: string;
  wsUrl: string;
  projectId: string | undefined;
  enabled: boolean;
  sampleRate: number;
  /** Optional seed for deterministic sampling. When set, the same trace name always produces the same sample decision. */
  sampleSeed: string | undefined;
  /** Transport mode. "auto" (default) tries WebSocket then falls back to HTTP; "http" is
   *  request/response only (recommended for short-lived scripts and serverless — it never
   *  holds an open socket and always surfaces upload errors); "ws" forces WebSocket. */
  transport: "auto" | "ws" | "http";
  /** Called with a STRUCTURED signal when the server signals credits_exhausted | rate_limited |
   *  halt | error. Branch on `signal.code`; use `signal.retryable`/`signal.fatal` to decide
   *  behavior. Defaults to a throttled console warning so signals are never silently dropped. */
  onError?: (signal: import("./errors.js").RetraceServerSignal) => void;
}

const config: Config = {
  apiKey: process.env.RETRACE_API_KEY || "",
  baseUrl: process.env.RETRACE_BASE_URL || "https://api-retrace.yashbogam.me",
  wsUrl: "",
  projectId: process.env.RETRACE_PROJECT_ID || undefined,
  enabled: !["false", "0"].includes((process.env.RETRACE_ENABLED || "true").toLowerCase()),
  sampleRate: parseFloat(process.env.RETRACE_SAMPLE_RATE || "1"),
  sampleSeed: process.env.RETRACE_SAMPLE_SEED || undefined,
  transport: (["auto", "ws", "http"].includes(process.env.RETRACE_TRANSPORT || "") ? process.env.RETRACE_TRANSPORT : "auto") as "auto" | "ws" | "http",
};
config.wsUrl = config.baseUrl.replace("https://", "wss://").replace("http://", "ws://");

export function configure(opts: Partial<Config>): Config {
  if (opts.apiKey && !opts.apiKey.startsWith("rt_live_")) {
    throw new Error("Invalid Retrace API key. Keys must start with 'rt_live_'. Get yours at https://retrace.yashbogam.me/settings");
  }
  Object.assign(config, opts);
  if (opts.baseUrl && !opts.wsUrl) {
    config.wsUrl = config.baseUrl.replace("https://", "wss://").replace("http://", "ws://");
  }
  // Eagerly install provider interceptors so clients constructed AFTER configure() are patched.
  // @google/genai binds generateContent as an own instance property, and our accessor only wraps
  // instances built after install — so install must precede client construction. Fire-and-forget;
  // the dynamic import resolves before the first awaited LLM call in any real async flow.
  if (config.enabled) {
    void import("./interceptors/install.js").then((m) => m.ensureInterceptorsInstalled()).catch(() => {});
  }
  return config;
}

export function requireApiKey(): string {
  if (!config.apiKey) {
    throw new Error("Retrace API key required. Call configure({ apiKey: 'rt_live_...' }) or set RETRACE_API_KEY. Get yours at https://retrace.yashbogam.me/settings");
  }
  return config.apiKey;
}

export function getConfig(): Config {
  return config;
}
