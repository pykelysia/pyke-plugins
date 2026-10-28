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
  it('旧版 <项目>/.ui-draw/board.json 迁移为项目里的第一块画布', () => {
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
    expect(rt.boardCount).toBe(1)
    const brt = rt.board('默认画布')!
    expect(brt.service.board.elements.map((e) => e.id)).toEqual(['old1'])
    expect(existsSync(brt.storePath)).toBe(true)
    rt.dispose()
  })

  it('旧版用户目录单画布 board.json 也迁移为 boards/ 下第一块画布', () => {
    process.env.UI_DRAW_HOME = mkdtempSync(join(tmpdir(), 'ui-draw-hub-migrate2-'))
    const proj = join(process.env.UI_DRAW_HOME, 'work', 'hub-legacy')
    mkdirSync(proj, { recursive: true })
    const legacyBoard = {
      version: 1,
      board: {
        width: 1440,
        height: 900,
        grid: true,
        layers: [
          { name: '草稿', visible: true },
          { name: '线稿', visible: true },
          { name: '批注', visible: true },
        ],
        activeLayer: '草稿',
        elements: [],
      },
    }
    mkdirSync(join(process.env.UI_DRAW_HOME, 'projects', 'hub-legacy'), { recursive: true })
    writeFileSync(
      join(process.env.UI_DRAW_HOME, 'projects', 'hub-legacy', 'board.json'),
      JSON.stringify(legacyBoard),
      'utf-8',
    )

    const reg = new ProjectRegistry()
    const meta = reg.register(proj)
    const rt = new ProjectRuntime(meta)
    expect(rt.boardCount).toBe(1)
    expect(rt.listBoards()[0].title).toBe('默认画布')
    // 迁移后旧文件应被清掉，避免下次误判
    expect(existsSync(join(process.env.UI_DRAW_HOME, 'projects', 'hub-legacy', 'board.json'))).toBe(false)
    rt.dispose()
  })
})

describe('一个项目多块画布', () => {
  it('createBoard 支新画布、标题唯一、互不串台；提交后摘要同步', () => {
    process.env.UI_DRAW_HOME = mkdtempSync(join(tmpdir(), 'ui-draw-hub-boards-'))
    const proj = join(process.env.UI_DRAW_HOME, 'work', 'multi')
    mkdirSync(proj, { recursive: true })
    const reg = new ProjectRegistry()
    const rt = new ProjectRuntime(reg.register(proj))

    expect(rt.boardCount).toBe(0)
    expect(rt.latestBoard()).toBeUndefined()

    const login = rt.createBoard('登录页', { width: 390, height: 844, grid: true })
    expect(login.id).toBe('登录页')
    expect(rt.boardCount).toBe(1)

    const settings = rt.createBoard('设置页', { width: 1280, height: 800, grid: true })
    expect(settings.id).toBe('设置页')

    // 同标题拒绝，提示切过去或换名
    expect(() => rt.createBoard('登录页', { width: 390, height: 844, grid: true })).toThrow(/switch_board/)

    // 各画布独立作画
    login.service.commit({
      type: 'addElement',
      element: { id: 'a1', kind: 'rect', layer: '草稿', x: 0, y: 0, w: 10, h: 10, color: '#000', width: 1 },
    })
    settings.service.commit({
      type: 'addElement',
      element: { id: 's1', kind: 'text', layer: '草稿', x: 0, y: 0, content: '设置', size: 14, color: '#000' },
    })
    expect(login.service.board.elements.map((e) => e.id)).toEqual(['a1'])
    expect(settings.service.board.elements.map((e) => e.id)).toEqual(['s1'])

    // 摘要随提交更新；最近更新的一块是 latest
    const metas = rt.listBoards()
    expect(metas.find((b) => b.id === '登录页')?.elements).toBe(1)
    expect(metas.find((b) => b.id === '设置页')?.elements).toBe(1)
    expect(rt.latestBoard()!.id).toBe('设置页')

    // 按 id 或标题都能打开同一块画布
    expect(rt.board('登录页')!.id).toBe('登录页')

    rt.flush()
    expect(existsSync(login.storePath)).toBe(true)
    expect(existsSync(settings.storePath)).toBe(true)

    // 重建：新实例从磁盘索引读回同样的画布清单
    const rt2 = new ProjectRuntime(rt.meta)
    expect(rt2.boardCount).toBe(2)
    expect(rt2.board('登录页')!.service.board.elements.map((e) => e.id)).toEqual(['a1'])
    rt.dispose()
    rt2.dispose()
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
