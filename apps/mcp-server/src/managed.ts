// App-owned entry point. Bundled as a standalone executable, never a DB client.
import { startMcpServer } from './index.js';

startMcpServer([], { managed: true }).catch((error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE'
    ? 'port_in_use'
    : 'start_failed';
  // Only this fixed protocol event crosses into native status; never forward errors or credentials.
  process.stderr.write(`${JSON.stringify({ event: 'mindwtr-mcp-error', code })}\n`);
  process.exit(1);
});
