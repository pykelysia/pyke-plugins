import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerTools } from '../src/mcp/tools.js'

describe('MCP tool schemas', () => {
  it('exports points as fixed-length numeric arrays without tuple-only JSON Schema keywords', async () => {
    const server = new McpServer({ name: 'schema-test', version: '0' })
    registerTools(server, { client: async () => { throw new Error('unused') } })
    const client = new Client({ name: 'schema-test', version: '0' })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const tools = (await client.listTools()).tools

      const resize = tools.find((candidate) => candidate.name === 'resize_board')
      expect(resize, 'resize_board is registered').toBeDefined()
      expect(resize!.inputSchema.properties?.width).toMatchObject({ type: 'integer', minimum: 200, maximum: 4096 })
      expect(resize!.inputSchema.properties?.height).toMatchObject({ type: 'integer', minimum: 200, maximum: 16384 })
      expect(resize!.inputSchema.required ?? []).not.toContain('width')
      expect(resize!.inputSchema.required ?? []).not.toContain('height')

      const setup = tools.find((candidate) => candidate.name === 'setup_board')
      expect(setup!.inputSchema.properties?.height).toMatchObject({ type: 'integer', maximum: 16384 })

      for (const [name, minimumPoints] of [['draw_stroke', 2], ['erase', 1]] as const) {
        const tool = tools.find((candidate) => candidate.name === name)
        expect(tool, `${name} is registered`).toBeDefined()
        const points = tool!.inputSchema.properties?.points as Record<string, unknown>
        expect(points.type).toBe('array')
        expect(points.items).toMatchObject({
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: { type: 'number' },
        })
        expect(Array.isArray((points.items as Record<string, unknown>).items)).toBe(false)
        expect((points.items as Record<string, unknown>).additionalItems).toBeUndefined()
        expect((points.items as Record<string, unknown>).prefixItems).toBeUndefined()
        expect(points.minItems).toBe(minimumPoints)
      }
    } finally {
      await client.close()
      await server.close()
    }
  })
})
