/**
 * Enforce intra-package domain layering inside `packages/client/*\/src/client/`.
 * verify-module-graph covers package-level edges; this gate covers the
 * directory level: domain directories may import `contract/` and never each
 * other, and only the assembly point (`apply.ts` / `index.ts`) may import
 * across domains.
 *
 * Layer model (lower may not import higher):
 *   0  contract/            shared contract API (types + slot declarations)
 *   1  <domain>/ + service  domain implementations (skeleton/, chat/, ...)
 *   2  apply.ts, index.ts   assembly point and re-export shell
 *
 * Root-boundary rule: imports are resolved against the actual `src/client/`
 * directory. Any relative target that lands outside that root (i.e. the
 * resolved relative path starts with `..`) is governed by package-level
 * import rules, not this gate, and is ignored here.
 *
 * Run directly:
 *   pnpm exec tsx scripts/verify-client-domain-graph.ts
 */

import { globSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const CLIENT_DIR = join(root, 'packages/client')

/** Directory names treated as the shared contract layer (importable by all). */
export const CONTRACT_DIRS = new Set(['contract'])
/** Top-level client files allowed to import across domains (assembly layer). */
export const ASSEMBLY_FILES = new Set(['apply.ts', 'index.ts', 'index.tsx'])

export interface Violation { file: string; imported: string; reason: string }

/** Recursively list .ts/.tsx files under dir (relative paths). */
export function listSources(dir: string): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: dir })
    .map(rel => rel.split(sep).join('/'))
    .filter(rel => !/\.legacy\./.test(rel.slice(rel.lastIndexOf('/') + 1)))
    .sort()
}

/** First path segment of a client-relative file, or '' for top-level files. */
export function domainOf(rel: string): string {
  const ix = rel.indexOf('/')
  return ix === -1 ? '' : rel.slice(0, ix)
}

/**
 * Resolve a relative import specifier against the importing file and the
 * client-root directory.
 * @returns The normalized path relative to clientRoot, and whether it escapes
 *          the client root (starts with `..`).
 */
export function resolveClientImport(
  clientRoot: string,
  importerRel: string,
  specifier: string,
): { targetRel: string; outside: boolean } {
  const importerDir = importerRel.includes('/') ? dirname(importerRel) : ''
  const targetAbs = resolve(clientRoot, importerDir, specifier)
  const targetRel = relative(clientRoot, targetAbs).split(sep).join('/')
  const outside = targetRel === '..' || targetRel.startsWith('../')
  return { targetRel, outside }
}

export function checkPackage(pkgName: string, clientDir: string): Violation[] {
  const violations: Violation[] = []
  const files = listSources(clientDir)
  for (const rel of files) {
    const fromDomain = domainOf(rel)
    const isAssembly = fromDomain === '' && ASSEMBLY_FILES.has(rel)
    if (isAssembly) continue
    const source = readFileSync(join(clientDir, rel), 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = match[1]
      if (spec === undefined) continue
      const { targetRel, outside } = resolveClientImport(clientDir, rel, spec)
      if (outside) continue // outside src/client — package-level rules govern
      const toDomain = domainOf(targetRel)
      if (toDomain === '' || CONTRACT_DIRS.has(toDomain)) continue // top-level shared file or contract layer
      if (fromDomain === toDomain) continue // inside one domain
      violations.push({
        file: `${pkgName}/src/client/${rel}`,
        imported: spec,
        reason: fromDomain === ''
          ? `top-level non-assembly file imports domain "${toDomain}" (only apply/index may assemble)`
          : `domain "${fromDomain}" imports sibling domain "${toDomain}" (route shared API through contract/)`,
      })
    }
  }
  return violations
}

function run(): number {
  const violations: Violation[] = []
  for (const pkg of readdirSync(CLIENT_DIR)) {
    const clientDir = join(CLIENT_DIR, pkg, 'src/client')
    try {
      if (!statSync(clientDir).isDirectory()) continue
    } catch {
      // No client half in this package — nothing to layer-check.
      continue
    }
    violations.push(...checkPackage(pkg, clientDir))
  }

  if (violations.length > 0) {
    console.error(`verify-client-domain-graph: ${violations.length} violation(s):`)
    for (const v of violations) console.error(`  ${v.file} -> ${v.imported}\n    ${v.reason}`)
    return 1
  }
  console.log('verify-client-domain-graph: client domain layering clean.')
  return 0
}

if (import.meta.main) {
  process.exit(run())
}
