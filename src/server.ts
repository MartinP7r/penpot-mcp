#!/usr/bin/env node
/**
 * server.ts
 *
 * MCP stdio server exposing headless Penpot project/file/content tools.
 * No browser, no Penpot plugin session — pure RPC calls against
 * PENPOT_BASE_URL, authenticated with PENPOT_ACCESS_TOKEN.
 *
 * This package has no project-specific knowledge: colors/fonts are
 * resolved from whatever file PENPOT_TOKENS_PATH points at, set per
 * consuming project. See README.md for setup instructions.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { loadConfig } from './config.js'
import { PenpotRpcClient, PenpotRpcError } from './rpc-client.js'
import { PenpotExporterClient } from './exporter-client.js'
import { initCheckpointStore } from './checkpoints.js'
import { projectFileTools, type ToolDefinition } from './tools/project-files.js'
import { contentTools } from './tools/content.js'
import { commentTools } from './tools/comments.js'
import { snapshotTools } from './tools/snapshots.js'
import { registerExportTool } from './tools/export.js'

const SAFE_RPC_ERROR_CODES = [
  'revision-conflict',
  'validation',
  'unauthorized',
  'forbidden',
  'not-found',
] as const
type SafeRpcErrorCode = (typeof SAFE_RPC_ERROR_CODES)[number]

export type McpToolResponse = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * Return a code only when a top-level server value exactly matches a fixed,
 * reviewed identifier. Server text and arbitrary response fields are never
 * copied to the MCP response.
 */
export function safeRpcErrorCode(body: unknown): SafeRpcErrorCode | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const candidate = [record.code, record.error, record.type].find((value) => typeof value === 'string')
  return SAFE_RPC_ERROR_CODES.find((code) => code === candidate)
}

function formatToolError(err: unknown): string {
  if (err instanceof PenpotRpcError) {
    const code = safeRpcErrorCode(err.body)
    return JSON.stringify({
      error: {
        type: 'penpot-rpc-error',
        method: err.method,
        status: err.status,
        ...(code ? { code } : {}),
      },
    })
  }
  return err instanceof Error ? err.message : 'Unknown error'
}

/**
 * Wrap a tool exactly as it is exposed over MCP. Keeping this boundary
 * separately testable ensures RPC failures retain their method, status, and only
 * allowlisted fixed codes instead of reflecting an opaque server response.
 */
export function createMcpToolHandler<TInput>(
  tool: ToolDefinition<TInput>,
  client: PenpotRpcClient,
): (input: unknown) => Promise<McpToolResponse> {
  return async (input: unknown) => {
    try {
      const parsedInput = tool.inputSchema.parse(input ?? {})
      const result = await tool.handler(client, parsedInput)
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: formatToolError(err) }],
        isError: true,
      }
    }
  }
}

export function registerTools(server: McpServer, client: PenpotRpcClient, tools: ToolDefinition<any>[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      createMcpToolHandler(tool, client),
    )
  }
}

export async function main(): Promise<void> {
  const config = loadConfig()
  const client = new PenpotRpcClient(config.PENPOT_BASE_URL, config.PENPOT_ACCESS_TOKEN)

  // Initialise disk-backed checkpoint storage when PENPOT_CHECKPOINTS_PATH is set.
  // Without this, checkpoints live only in process memory (the previous behaviour).
  if (config.PENPOT_CHECKPOINTS_PATH) {
    const { loaded } = await initCheckpointStore(config.PENPOT_CHECKPOINTS_PATH)
    if (loaded > 0) {
      process.stderr.write(`penpot-headless: loaded ${loaded} checkpoint(s) from ${config.PENPOT_CHECKPOINTS_PATH}\n`)
    }
  }

  const server = new McpServer({
    name: 'penpot-headless',
    version: '0.2.0',
  })

  registerTools(server, client, projectFileTools)
  registerTools(server, client, contentTools(config.PENPOT_TOKENS_PATH))
  registerTools(server, client, commentTools)
  registerTools(server, client, snapshotTools)

  // Register penpot_export_shape if any auth mode for the exporter is configured.
  // Priority: PENPOT_LOGIN_EMAIL/PASSWORD (password login) > PENPOT_OIDC_USERNAME/PASSWORD
  // (headless OIDC) > PENPOT_AUTH_TOKEN_COOKIE (pre-obtained SSO/OIDC cookie).
  if (config.PENPOT_LOGIN_EMAIL && config.PENPOT_LOGIN_PASSWORD) {
    const exporter = new PenpotExporterClient(config.PENPOT_BASE_URL, {
      mode: 'password',
      email: config.PENPOT_LOGIN_EMAIL,
      password: config.PENPOT_LOGIN_PASSWORD,
    })
    registerExportTool(server, exporter)
  } else if (config.PENPOT_OIDC_USERNAME && config.PENPOT_OIDC_PASSWORD) {
    const exporter = new PenpotExporterClient(config.PENPOT_BASE_URL, {
      mode: 'oidc',
      username: config.PENPOT_OIDC_USERNAME,
      password: config.PENPOT_OIDC_PASSWORD,
      provider: config.PENPOT_OIDC_PROVIDER,
    })
    registerExportTool(server, exporter)
  } else if (config.PENPOT_AUTH_TOKEN_COOKIE) {
    const exporter = new PenpotExporterClient(config.PENPOT_BASE_URL, {
      mode: 'cookie',
      authTokenCookie: config.PENPOT_AUTH_TOKEN_COOKIE,
    })
    registerExportTool(server, exporter)
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const entrypoint = process.argv[1]
if (entrypoint && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Unknown error'
    process.stderr.write(`penpot-headless server failed to start: ${message}\n`)
    process.exitCode = 1
  })
}
