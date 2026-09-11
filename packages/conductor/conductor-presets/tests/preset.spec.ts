import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROLE_DIR, ROLE_SKILL, ROLE_SKILL_NAMES } from '../src/index.ts'

const PRESET_PATH = 'apps/cli/config/agent-presets/conductor/agent.cordis.yml'

describe('dsh-conductor-presets', () => {
  it('ships exactly one role skill per gated stage with a matching frontmatter name', async () => {
    const files = (await readdir(ROLE_DIR)).filter(name => name.endsWith('.md')).sort()
    const discovered = new Set<string>()
    for (const file of files) {
      const content = await readFile(join(ROLE_DIR, file), 'utf8')
      const name = /^---\nname: ([a-z0-9-]+)\n/.exec(content)?.[1]
      expect(name, `${file} frontmatter name`).toBeTruthy()
      discovered.add(name!)
      expect(content).toMatch(/^description: \S/m)
      expect(content).toMatch(/^disable-model-invocation: true$/m)
      expect(content).toMatch(/^user-invocable: false$/m)
    }
    expect([...discovered].sort()).toEqual([...ROLE_SKILL_NAMES].sort())
  })

  it('maps every gated stage to a distinct role skill', () => {
    expect(Object.keys(ROLE_SKILL)).toHaveLength(7)
    expect(new Set(Object.values(ROLE_SKILL)).size).toBe(7)
    expect(ROLE_SKILL_NAMES).toEqual([
      'conductor-detective',
      'conductor-strategist',
      'conductor-devils-advocate',
      'conductor-headsman',
      'conductor-auditor',
      'conductor-integrator',
      'conductor-arbiter',
    ])
  })

  it('the preset mounts the tool and the isolated role loader', async () => {
    const content = await readFile(PRESET_PATH, 'utf8')
    expect(content).toContain("name: '@deepseek-ai/dsh-tool-conductor'")
    expect(content).toContain("name: '@deepseek-ai/dsh-skill-filesystem'")
    expect(content).toContain('includeDefaultRoots: false')
    expect(content).toContain(`- ${ROLE_DIR}`)
  })
})
