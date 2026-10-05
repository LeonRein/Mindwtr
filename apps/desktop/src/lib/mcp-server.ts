import { isSandboxMode } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';

export const MCP_SERVER_PORT = 8722;
export type McpServerError = 'port_in_use' | 'start_failed' | 'exited' | 'config_failed';
export type McpServerStatus = {
    enabled: boolean;
    running: boolean;
    allowWrite: boolean;
    port: number;
    url: string | null;
    token: string | null;
    error: McpServerError | null;
};
export type McpServerConfig = {
    enabled: boolean;
    allowWrite: boolean;
    regenerateToken?: boolean;
};

export function isMcpServerAvailable(): boolean {
    return isTauriRuntime() && !isSandboxMode();
}

function assertAvailable(): void {
    if (!isMcpServerAvailable()) throw new Error('MCP is unavailable.');
}

export function normalizeMcpServerError(error: unknown): McpServerError | null {
    if (error === null || error === undefined) return null;
    return ['port_in_use', 'start_failed', 'exited', 'config_failed'].includes(String(error))
        ? error as McpServerError
        : 'config_failed';
}

function normalizeStatus(status: McpServerStatus): McpServerStatus {
    return { ...status, error: normalizeMcpServerError(status.error) };
}

export async function getMcpServerStatus(): Promise<McpServerStatus> {
    assertAvailable();
    return normalizeStatus(await invokeNative<McpServerStatus>('get_mcp_server_status'));
}

export async function setMcpServerConfig(config: McpServerConfig): Promise<McpServerStatus> {
    assertAvailable();
    return normalizeStatus(await invokeNative<McpServerStatus>('set_mcp_server_config', { ...config }));
}

/** Contains a credential: generate only for an explicit copy action, never for logs or display. */
export function getMcpConnectionDetails(status: McpServerStatus): string | null {
    if (!status.enabled || !status.running || !status.token || status.url !== `http://127.0.0.1:${MCP_SERVER_PORT}/mcp`) return null;
    return JSON.stringify({
        mcpServers: {
            mindwtr: { url: status.url, headers: { Authorization: `Bearer ${status.token}` } },
        },
    }, null, 2);
}
