import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '..')

test('root index.html remains a minimal Vite React shell', async () => {
  const html = await readFile(path.join(repoRoot, 'index.html'), 'utf8')

  assert.match(html, /<div id="root"><\/div>/)
  assert.match(html, /<script type="module" src="\/src\/main\.tsx"><\/script>/)
  assert.doesNotMatch(html, /<style[\s>]/i)
  assert.doesNotMatch(html, /<main[\s>]/i)
})
