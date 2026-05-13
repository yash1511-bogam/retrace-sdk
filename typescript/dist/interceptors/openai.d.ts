import { SpanData } from "../trace.js";
export declare function installOpenAIInterceptor(onSpan: (span: SpanData) => void): void;
export declare function uninstallOpenAIInterceptor(): void;
