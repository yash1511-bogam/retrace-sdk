export interface Config {
  apiKey: string;
  baseUrl: string;
  wsUrl: string;
  projectId: string | undefined;
  enabled: boolean;
  sampleRate: number;
}

const config: Config = {
  apiKey: process.env.RETRACE_API_KEY || "",
  baseUrl: process.env.RETRACE_BASE_URL || "https://api-retrace.yashbogam.me",
  wsUrl: "",
  projectId: process.env.RETRACE_PROJECT_ID || undefined,
  enabled: !["false", "0"].includes((process.env.RETRACE_ENABLED || "true").toLowerCase()),
  sampleRate: parseFloat(process.env.RETRACE_SAMPLE_RATE || "1"),
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
