import { afterAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slugify } from '../src/hub/paths'
import { resolveProjectDir } from '../src/hub/project-dir'
import { ProjectRegistry, ProjectRuntime } from '../src/hub/projects'
import { HubServer } from '../src/hub/server'

const originalHome = process.env.UI_DRAW_HOME
afterAll(() => {
  if (originalHome === undefined) delete process.env.UI_DRAW_HOME
  else process.env.UI_DRAW_HOME = originalHome
})

describe('项目名 → 路径 slug', () => {
  it('空格与非法字符换成 -，保留中文', () => {
    expect(slugify('my app')).toBe('my-app')
    expect(slugify('项目 A/一')).toBe('项目-A-一')
    expect(slugify('  ...  ')).toBe('project')
    expect(slugify('a?b:c*d')).toBe('a-b-c-d')
  })
})

describe('ProjectRegistry', () => {
  it('不同目录同名项目得到不同 slug，且同一目录稳定', () => {
    process.env.UI_DRAW_HOME = mkdtempSync(join(tmpdir(), 'ui-draw-hub-'))
    const a = join(process.env.UI_DRAW_HOME, 'x', 'app')
    const b = join(process.env.UI_DRAW_HOME, 'y', 'app')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })

    const reg = new ProjectRegistry()
    const ma = reg.register(a)
    const mb = reg.register(b)
    expect(ma.slug).toBe('app')
    expect(ma.name).toBe('app')
    expect(mb.slug).toBe('app-2')
    expect(reg.register(a).slug).toBe('app')
    expect(reg.list()).toHaveLength(2)
  })
})

describe('项目目录解析', () => {
  it('子目录工作也能落到 package.json 所在项目根', () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-draw-proj-'))
    writeFileSync(join(root, 'package.json'), '{}')
    const sub = join(root, 'src', 'views')
    mkdirSync(sub, { recursive: true })
    expect(resolveProjectDir(sub)).toBe(root)
  })

  it('git 根优先于 package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-draw-git-'))
    mkdirSync(join(root, '.git'))
    const pkgDir = join(root, 'web')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{}')
    expect(resolveProjectDir(join(pkgDir))).toBe(root)
  })

  it('没有项目标记时用当前目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-draw-bare-'))
    expect(resolveProjectDir(dir)).toBe(dir)
  })
})

describe('项目存档迁移', () => {
  it('旧版 <项目>/.ui-draw/board.json 会迁移到用户目录', () => {
    process.env.UI_DRAW_HOME = mkdtempSync(join(tmpdir(), 'ui-draw-hub-migrate-'))
    const proj = join(process.env.UI_DRAW_HOME, 'work', 'legacy-app')
    mkdirSync(join(proj, '.ui-draw'), { recursive: true })
    const legacyBoard = {
      version: 1,
      board: {
        width: 1280,
        height: 800,
        grid: true,
        layers: [
          { name: '草稿', visible: true },
          { name: '线稿', visible: true },
          { name: '批注', visible: true },
        ],
        activeLayer: '线稿',
        elements: [
          { id: 'old1', kind: 'rect', layer: '线稿', x: 10, y: 10, w: 100, h: 50, color: '#111827', width: 2 },
        ],
      },
    }
    writeFileSync(join(proj, '.ui-draw', 'board.json'), JSON.stringify(legacyBoard), 'utf-8')

    const reg = new ProjectRegistry()
    const meta = reg.register(proj)
    const rt = new ProjectRuntime(meta)
    expect(rt.service.board.elements.map((e) => e.id)).toEqual(['old1'])
    expect(existsSync(rt.storePath)).toBe(true)
    rt.dispose()
  })
})

describe('HubServer 端口', () => {
  it('默认端口被占用时顺延', async () => {
    process.env.UI_DRAW_HOME = mkdtempSync(join(tmpdir(), 'ui-draw-hub-port-'))
    const blocker = createServer(() => {})
    await new Promise<void>((ok) => blocker.listen(0, '127.0.0.1', () => ok()))
    const blocked = (blocker.address() as { port: number }).port

    const hub = new HubServer()
    const port = await hub.start(blocked)
    expect(port).toBeGreaterThan(blocked)
    await hub.stop()
    await new Promise<void>((ok) => blocker.close(() => ok()))
  })
})
