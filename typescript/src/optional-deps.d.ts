// Type declarations for optional peer dependencies.
// These allow dynamic import() to compile without the packages installed.
declare module "openai" {
  const mod: unknown;
  export default mod;
  export const OpenAI: unknown;
}

declare module "@anthropic-ai/sdk" {
  const mod: unknown;
  export default mod;
  export const Anthropic: unknown;
}
