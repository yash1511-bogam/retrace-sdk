export interface Config {
    apiKey: string;
    baseUrl: string;
    wsUrl: string;
    projectId: string | undefined;
    enabled: boolean;
}
export declare function configure(opts: Partial<Config>): Config;
export declare function requireApiKey(): string;
export declare function getConfig(): Config;
