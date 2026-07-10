/**
 * Removes IDE/Volar artifacts and stray .js twins that shadow .ts in Vite
 * (resolve order prefers .js over .ts).
 *
 * Safe: only deletes *.vue.js everywhere under client/src, and named *.js
 * when the matching *.ts exists beside it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'client', 'src')

const SHADOW_PAIRS = [
  ['main.js', 'main.ts'],
  ['router.js', 'router.ts'],
  [path.join('api', 'client.js'), path.join('api', 'client.ts')],
  ['types.js', 'types.ts'],
  [path.join('hooks', 'useStrategyEngine.js'), path.join('hooks', 'useStrategyEngine.ts')],
  [path.join('composables', 'useTweaks.js'), path.join('composables', 'useTweaks.ts')]
]

let removed = 0

function rmIfExists(p) {
  if (!fs.existsSync(p)) return
  fs.rmSync(p)
  removed += 1
  console.log('removed', path.relative(root, p))
}

if (fs.existsSync(srcDir)) {
  for (const [jsRel, tsRel] of SHADOW_PAIRS) {
    const jsPath = path.join(srcDir, jsRel)
    const tsPath = path.join(srcDir, tsRel)
    if (fs.existsSync(jsPath) && fs.existsSync(tsPath)) rmIfExists(jsPath)
  }

  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ent.name.endsWith('.vue.js')) rmIfExists(p)
    }
  }
  walk(srcDir)
}

console.log(`clean-client-ghost-js: done (${removed} file(s))`)
