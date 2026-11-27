import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SynsbasenClient, type SynsbasenClientOptions } from './synsbasen/client.js';
import { registerTools } from './tools/synsbasen.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: SynsbasenClient;
  clientOptions?: SynsbasenClientOptions;
}

let defaultClient: SynsbasenClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): SynsbasenClient {
  defaultClient ??= new SynsbasenClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'synsbasen',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new SynsbasenClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
