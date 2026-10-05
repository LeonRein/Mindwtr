import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ native: vi.fn(), tauri: true, sandbox: false }));
vi.mock('@mindwtr/core', () => ({ isSandboxMode: () => mocks.sandbox }));
vi.mock('./runtime', () => ({ isTauriRuntime: () => mocks.tauri }));
vi.mock('./tauri-invoke', () => ({ invokeNative: mocks.native }));
import { getMcpConnectionDetails, getMcpServerStatus, isMcpServerAvailable, setMcpServerConfig, type McpServerStatus } from './mcp-server';

const status: McpServerStatus = {
    enabled: true, running: true, allowWrite: false, port: 8722,
    url: 'http://127.0.0.1:8722/mcp', token: 'private-token', error: null,
};

describe('managed MCP adapter', () => {
    beforeEach(() => {
        mocks.tauri = true;
        mocks.sandbox = false;
        mocks.native.mockReset().mockResolvedValue(status);
    });

    it('uses the fixed native contract and sends read-only or rotation explicitly', async () => {
        expect(await getMcpServerStatus()).toEqual(status);
        expect(mocks.native).toHaveBeenCalledWith('get_mcp_server_status');
        await setMcpServerConfig({ enabled: true, allowWrite: false });
        expect(mocks.native).toHaveBeenLastCalledWith('set_mcp_server_config', { enabled: true, allowWrite: false });
        await setMcpServerConfig({ enabled: true, allowWrite: true, regenerateToken: true });
        expect(mocks.native).toHaveBeenLastCalledWith('set_mcp_server_config', { enabled: true, allowWrite: true, regenerateToken: true });
    });

    it.each(['browser', 'sandbox'])('never invokes external native commands in %s', async (runtime) => {
        mocks.tauri = runtime !== 'browser';
        mocks.sandbox = runtime === 'sandbox';
        expect(isMcpServerAvailable()).toBe(false);
        await expect(getMcpServerStatus()).rejects.toThrow('unavailable');
        await expect(setMcpServerConfig({ enabled: true, allowWrite: false })).rejects.toThrow('unavailable');
        expect(mocks.native).not.toHaveBeenCalled();
    });

    it('maps unexpected native error text to a safe error code', async () => {
        mocks.native.mockResolvedValue({ ...status, error: 'private-token or task text in a raw error' });
        expect((await getMcpServerStatus()).error).toBe('config_failed');
    });

    it('copies URL and bearer configuration only for a running loopback server', () => {
        const details = getMcpConnectionDetails(status);
        expect(JSON.parse(details!)).toEqual({
            mcpServers: { mindwtr: { url: status.url, headers: { Authorization: 'Bearer private-token' } } },
        });
        for (const patch of [
            { enabled: false }, { running: false }, { token: null }, { url: 'http://external.example/mcp' },
        ]) expect(getMcpConnectionDetails({ ...status, ...patch })).toBeNull();
    });
});
