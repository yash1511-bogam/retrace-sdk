export interface Transport {
    send(eventType: string, data: Record<string, unknown>): void;
    close(): void;
}
export declare class WSTransport implements Transport {
    private ws;
    private connected;
    private closed;
    private backoff;
    private queue;
    get isConnected(): boolean;
    connect(): void;
    private reconnect;
    private flushQueue;
    send(eventType: string, data: Record<string, unknown>): void;
    close(): void;
}
export declare class HTTPTransport implements Transport {
    private traceData;
    private spans;
    send(eventType: string, data: Record<string, unknown>): void;
    flush(): void;
    private buildSpans;
    close(): void;
}
export declare function createTransport(mode?: "ws" | "http" | "auto"): Transport;
