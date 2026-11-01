/**
 * Regression coverage for mutation diagnostics returned by content MCP tools.
 */
import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { contentTools } from '../../src/tools/content.js'
import { ROOT_FRAME_ID } from '../../src/shape-builders.js'
import type { PenpotRpcClient } from '../../src/rpc-client.js'
import type { ZodType } from 'zod'

type AnyTool = {
  name: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: ZodType<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (client: PenpotRpcClient, input: any) => Promise<unknown>
}

const FILE_ID = 'file-1'
const PAGE_ID = 'page-1'
const OBSERVED_REVN = 7
const TEST_TOKENS_PATH = resolve(import.meta.dirname, '../integration/fixtures/tokens.json')
const TOOLS = contentTools('/dev/null') as unknown as AnyTool[]

function getTool(name: string): AnyTool {
  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

function callTool(tool: AnyTool, client: PenpotRpcClient, input: Record<string, unknown>): Promise<unknown> {
  return tool.handler(client, tool.inputSchema.parse(input))
}

function makeClient(
  updateResult: { revn: number; lagged?: unknown[] } = { revn: 12, lagged: [] },
  objects: Record<string, unknown> = {
    [ROOT_FRAME_ID]: {
      id: ROOT_FRAME_ID,
      type: 'frame',
      shapes: [],
    },
  },
): PenpotRpcClient {
  return {
    getFile: vi.fn().mockResolvedValue({
      id: FILE_ID,
      revn: OBSERVED_REVN,
      vern: 3,
      data: {
        pages: [PAGE_ID],
        pagesIndex: {
          [PAGE_ID]: {
            name: 'Page 1',
            objects,
          },
        },
      },
    }),
    updateFile: vi.fn().mockResolvedValue(updateResult),
  } as unknown as PenpotRpcClient
}

function makeRect(id: string, x: number): Record<string, unknown> {
  return { id, type: 'rect', x, y: 0, width: 10, height: 10, shapes: [] }
}

describe('content mutation diagnostics', () => {
  it('exposes only the count for mixed lagged diagnostics without retrying', async () => {
    const lagged = [
      { id: 'self-change-id', revn: 7, fileId: FILE_ID, sessionId: 'this-client-session', changes: [] },
      {
        id: 'other-change-id',
        revn: 8,
        fileId: FILE_ID,
        sessionId: 'other-client-session',
        changes: [{ type: 'add-obj', obj: { content: 'other-session-private-content' } }],
      },
    ]
    const client = makeClient({ revn: 12, lagged })

    const result = (await callTool(getTool('penpot_create_page'), client, {
      fileId: FILE_ID,
      name: 'Design',
    })) as {
      revn: number
      mutation: {
        status: string
        observedRevn: number
        serverResponseRevn: number | null
        laggedCount: number | null
      }
    }

    // `revn` remains the legacy response alias; consumers that need an
    // unambiguous value use the named diagnostic fields below.
    expect(result.revn).toBe(12)
    expect(result.mutation).toEqual({
      status: 'applied',
      observedRevn: OBSERVED_REVN,
      serverResponseRevn: 12,
      laggedCount: 2,
    })
    expect(result.mutation).not.toHaveProperty('lagged')
    expect(JSON.stringify(result.mutation)).not.toContain('other-change-id')
    expect(JSON.stringify(result.mutation)).not.toContain('other-client-session')
    expect(JSON.stringify(result.mutation)).not.toContain('other-session-private-content')
    expect(result.mutation).not.toHaveProperty('concurrentWriter')
    expect(result.mutation).not.toHaveProperty('currentRevn')
    expect(client.updateFile).toHaveBeenCalledTimes(1)
  })

  it('reports a null lagged count when the update response omits lagged', async () => {
    const client = makeClient({ revn: 12 })

    const result = (await callTool(getTool('penpot_create_page'), client, {
      fileId: FILE_ID,
      name: 'Design',
    })) as { mutation: unknown }

    expect(result.mutation).toEqual({
      status: 'applied',
      observedRevn: OBSERVED_REVN,
      serverResponseRevn: 12,
      laggedCount: null,
    })
  })

  it('labels a replace-text no-match as a no-op with no server response revision', async () => {
    const client = makeClient()

    const result = (await callTool(getTool('penpot_replace_text'), client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      search: 'missing',
      replacement: 'replacement',
    })) as {
      replacedShapes: unknown[]
      mutation: {
        status: string
        observedRevn: number
        serverResponseRevn: number | null
        laggedCount: number | null
      }
    }

    expect(result.replacedShapes).toEqual([])
    expect(result.mutation).toEqual({
      status: 'no-op',
      observedRevn: OBSERVED_REVN,
      serverResponseRevn: null,
      laggedCount: null,
    })
    expect(client.updateFile).not.toHaveBeenCalled()
  })

  it.each([
    [
      'penpot_align_shapes',
      { shapeIds: ['a', 'b'], edge: 'left' },
      {
        [ROOT_FRAME_ID]: { id: ROOT_FRAME_ID, type: 'frame', shapes: ['a', 'b'] },
        a: makeRect('a', 0),
        b: makeRect('b', 0),
      },
    ],
    [
      'penpot_distribute_shapes',
      { shapeIds: ['a', 'b', 'c'], axis: 'horizontal' },
      {
        [ROOT_FRAME_ID]: { id: ROOT_FRAME_ID, type: 'frame', shapes: ['a', 'b', 'c'] },
        a: makeRect('a', 0),
        b: makeRect('b', 50),
        c: makeRect('c', 100),
      },
    ],
  ])('%s labels an already-satisfied operation as a no-op', async (toolName, operation, objects) => {
    const client = makeClient(undefined, objects)

    const result = (await callTool(getTool(toolName), client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
      tokensPath: TEST_TOKENS_PATH,
      ...operation,
    })) as { mutation: unknown }

    expect(result.mutation).toEqual({
      status: 'no-op',
      observedRevn: OBSERVED_REVN,
      serverResponseRevn: null,
      laggedCount: null,
    })
    expect(client.updateFile).not.toHaveBeenCalled()
  })

  it('labels a restore whose empty checkpoint generates no changes as a no-op', async () => {
    const client = makeClient(undefined, {})
    const checkpoint = (await callTool(getTool('penpot_checkpoint'), client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
    })) as { checkpointId: string }

    try {
      const result = (await callTool(getTool('penpot_restore_checkpoint'), client, {
        checkpointId: checkpoint.checkpointId,
      })) as { mutation: unknown }

      expect(result.mutation).toEqual({
        status: 'no-op',
        observedRevn: OBSERVED_REVN,
        serverResponseRevn: null,
        laggedCount: null,
      })
      expect(client.updateFile).not.toHaveBeenCalled()
    } finally {
      await callTool(getTool('penpot_discard_checkpoint'), client, { checkpointId: checkpoint.checkpointId })
    }
  })

  it('reports applied for an unchanged nonempty checkpoint because restore still generates overwrite changes', async () => {
    const client = makeClient(undefined, {
      [ROOT_FRAME_ID]: {
        id: ROOT_FRAME_ID,
        type: 'frame',
        shapes: [],
      },
    })
    const checkpoint = (await callTool(getTool('penpot_checkpoint'), client, {
      fileId: FILE_ID,
      pageId: PAGE_ID,
    })) as { checkpointId: string }

    try {
      const result = (await callTool(getTool('penpot_restore_checkpoint'), client, {
        checkpointId: checkpoint.checkpointId,
      })) as { restoredShapeCount: number; deletedShapeCount: number; mutation: unknown }

      expect(result.restoredShapeCount).toBe(1)
      expect(result.deletedShapeCount).toBe(0)
      expect(result.mutation).toEqual({
        status: 'applied',
        observedRevn: OBSERVED_REVN,
        serverResponseRevn: 12,
        laggedCount: 0,
      })
      expect(client.updateFile).toHaveBeenCalledOnce()
    } finally {
      await callTool(getTool('penpot_discard_checkpoint'), client, { checkpointId: checkpoint.checkpointId })
    }
  })
})
