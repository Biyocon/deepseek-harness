import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkPackage, resolveClientImport } from './verify-client-domain-graph.ts'

function makeClientDir(): string {
  return mkdtempSync(join(tmpdir(), 'cdg-'))
}

function writeFiles(clientDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(clientDir, ...rel.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

describe('resolveClientImport', () => {
  it('flags top-level escape above client root', () => {
    const { targetRel, outside } = resolveClientImport('/c', 'controller.ts', '../core/detect')
    expect(outside).toBe(true)
    expect(targetRel.startsWith('..')).toBe(true)
  })

  it('flags multi-level escape above client root', () => {
    const { targetRel, outside } = resolveClientImport('/c', 'bar/file.ts', '../../core/out')
    expect(outside).toBe(true)
    expect(targetRel.startsWith('..')).toBe(true)
  })

  it('keeps nested sibling import inside client root', () => {
    const { targetRel, outside } = resolveClientImport('/c', 'foo/file.ts', '../bar/file')
    expect(outside).toBe(false)
    expect(targetRel).toBe('bar/file')
  })
})

describe('checkPackage root-boundary semantics', () => {
  let clientDir: string
  beforeEach(() => {
    clientDir = makeClientDir()
  })
  afterEach(() => {
    rmSync(clientDir, { recursive: true, force: true })
  })

  it('ignores a top-level ../core escape', () => {
    writeFiles(clientDir, {
      'controller.ts': "import { x } from '../core/detect.ts'\n",
    })
    expect(checkPackage('demo', clientDir)).toEqual([])
  })

  it('reports a nested ../bar sibling import', () => {
    writeFiles(clientDir, {
      'foo/file.ts': "import { x } from '../bar/file.ts'\n",
      'bar/file.ts': '',
    })
    const v = checkPackage('demo', clientDir)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({
      file: 'demo/src/client/foo/file.ts',
      imported: '../bar/file.ts',
      reason: 'domain "foo" imports sibling domain "bar" (route shared API through contract/)',
    })
  })

  it('reports a top-level ./runtime import', () => {
    writeFiles(clientDir, {
      'service.ts': "import { x } from './runtime/helper'\n",
      'runtime/helper.ts': '',
    })
    const v = checkPackage('demo', clientDir)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({
      file: 'demo/src/client/service.ts',
      imported: './runtime/helper',
      reason: 'top-level non-assembly file imports domain "runtime" (only apply/index may assemble)',
    })
  })

  it('ignores a multi-level ../../core escape', () => {
    writeFiles(clientDir, {
      'bar/file.ts': "import { x } from '../../core/out.ts'\n",
    })
    expect(checkPackage('demo', clientDir)).toEqual([])
  })

  it('exempts apply.ts and index.tsx assembly imports', () => {
    writeFiles(clientDir, {
      'apply.ts': "import { x } from './runtime/helper'\nimport { y } from '../core/detect.ts'\n",
      'index.tsx': "import { x } from './runtime/helper'\nimport { y } from '../core/detect.ts'\n",
      'runtime/helper.ts': '',
    })
    expect(checkPackage('demo', clientDir)).toEqual([])
  })

  it('exempts imports routed through contract/', () => {
    writeFiles(clientDir, {
      'queue/store.ts': "import { x } from '../contract/base.ts'\n",
      'contract/base.ts': '',
    })
    expect(checkPackage('demo', clientDir)).toEqual([])
  })

  it('preserves duplicate occurrences as separate violations', () => {
    writeFiles(clientDir, {
      'input/hub.ts': [
        "import { a } from '../queue/store'",
        "import { b } from '../queue/store'",
        '',
      ].join('\n'),
      'queue/store.ts': '',
    })
    const v = checkPackage('demo', clientDir)
    expect(v).toHaveLength(2)
    expect(v.every(x => x.file === 'demo/src/client/input/hub.ts' && x.imported === '../queue/store')).toBe(true)
  })
})
