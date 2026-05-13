import { SpanData } from "../trace.js";
export declare function installGeminiInterceptor(onSpan: (span: SpanData) => void): void;
export declare function uninstallGeminiInterceptor(): void;
