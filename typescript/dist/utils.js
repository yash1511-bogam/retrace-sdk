import { randomUUID } from "crypto";
export function genId() {
    return randomUUID();
}
export function nowIso() {
    return new Date().toISOString();
}
export function utcNow() {
    return new Date();
}
export function truncateJson(obj, maxBytes = 10240) {
    try {
        const s = JSON.stringify(obj);
        if (Buffer.byteLength(s) <= maxBytes)
            return obj;
        return JSON.parse(Buffer.from(s).subarray(0, maxBytes).toString());
    }
    catch {
        return String(obj).slice(0, maxBytes);
    }
}
