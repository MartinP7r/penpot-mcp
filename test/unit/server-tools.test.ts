/**
 * MCP-boundary error rendering tests: RPC failures must be actionable without
 * reflecting server response text, URLs, credentials, or arbitrary JSON.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMcpToolHandler } from '../../src/server.js'
import { PenpotRpcError, type PenpotRpcClient } from '../../src/rpc-client.js'
import { contentTools } from '../../src/tools/content.js'
import type { ToolDefinition } from '../../src/tools/project-files.js'

type ErrorPayload = {
  error: { type: string; method: string; status: number; code?: string }
}

describe('createMcpToolHandler', () => {
  it('exposes method, status, and an allowlisted fixed code without server text', async () => {
    const tool = contentTools('/dev/null').find((candidate) => candidate.name === 'penpot_create_page')! as unknown as ToolDefinition<{
      fileId: string
      name: string
    }>
    const client = {
      getFile: vi.fn().mockResolvedValue({ id: 'file-1', revn: 7, vern: 3, data: { pages: [], pagesIndex: {} } }),
      updateFile: vi.fn().mockRejectedValue(
        new PenpotRpcError('update-file', 409, {
          code: 'revision-conflict',
          message: 'server-message-should-not-leak https://errors.example.test/diagnostics',
          accessToken: 'credential-should-not-leak',
          nested: { password: 'credential-should-not-leak' },
        }),
      ),
    } as unknown as PenpotRpcClient

    const response = await createMcpToolHandler(tool, client)({ fileId: 'file-1', name: 'Design' })

    expect(response.isError).toBe(true)
    expect(response.content).toHaveLength(1)
    const payload = JSON.parse(response.content[0]!.text) as ErrorPayload
    expect(payload).toEqual({
      error: {
        type: 'penpot-rpc-error',
        method: 'update-file',
        status: 409,
        code: 'revision-conflict',
      },
    })
    expect(JSON.stringify(payload)).not.toContain('server-message-should-not-leak')
    expect(JSON.stringify(payload)).not.toContain('errors.example.test')
    expect(JSON.stringify(payload)).not.toContain('credential-should-not-leak')
    expect(client.updateFile).toHaveBeenCalledOnce()
  })

  it.each([
    ['plain-text server error', 'plain-server-text-should-not-leak https://plain.example.test/diagnostics'],
    [
      'JSON server error containing credentials and a URL',
      {
        code: 'untrusted-server-code-should-not-leak',
        message: 'json-server-text-should-not-leak',
        accessToken: 'json-credential-should-not-leak',
        url: 'https://json.example.test/private-diagnostics',
        nested: { cookie: 'json-cookie-should-not-leak' },
      },
    ],
  ])('does not reflect a %s', async (_description, body) => {
    const tool: ToolDefinition<Record<string, never>> = {
      name: 'penpot_test_error',
      description: 'Test-only error tool.',
      inputSchema: z.object({}),
      handler: async () => {
        throw new PenpotRpcError('update-file', 502, body)
      },
    }

    const response = await createMcpToolHandler(tool, {} as PenpotRpcClient)({})
    const payload = JSON.parse(response.content[0]!.text) as ErrorPayload

    expect(payload).toEqual({
      error: {
        type: 'penpot-rpc-error',
        method: 'update-file',
        status: 502,
      },
    })
    expect(JSON.stringify(payload)).not.toContain('should-not-leak')
    expect(JSON.stringify(payload)).not.toContain('example.test')
  })
})
