import { SpanData } from "../trace.js";
export declare function installAnthropicInterceptor(onSpan: (span: SpanData) => void): void;
export declare function uninstallAnthropicInterceptor(): void;
