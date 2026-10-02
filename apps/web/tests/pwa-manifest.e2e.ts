import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Biyocon Harness',
    short_name: 'Biyocon',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [
      {
        src: '/biyocon-brandmark-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/biyocon-brandmark-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  })
})

it('ships a PNG favicon and touch icon derived from the Biyocon brandmark', async () => {
  const favicon = await readFile(join(DIST_ROOT, 'favicon.png'))
  expect(favicon.length).toBeGreaterThan(0)
  const appleTouch = await readFile(join(DIST_ROOT, 'apple-touch-icon.png'))
  expect(appleTouch.length).toBeGreaterThan(0)
})
