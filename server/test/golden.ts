/**
 * Tiny golden-file helper (no snapshot framework needed).
 *
 * Stores expected output as readable JSON under test/__golden__/. On mismatch
 * the test fails with a diff hint. To intentionally accept new output:
 *   UPDATE_GOLDEN=1 npm test
 *
 * The JSON is human-readable on purpose — you can eyeball that a number that
 * shouldn't have moved didn't move, without understanding the math behind it.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = join(HERE, '__golden__')

export function matchGolden(name: string, actual: unknown): void {
  const file = join(GOLDEN_DIR, `${name}.json`)
  const serialized = JSON.stringify(actual, null, 2) + '\n'

  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(file, serialized, 'utf8')
    return
  }

  const expected = readFileSync(file, 'utf8')
  assert.equal(
    serialized,
    expected,
    `Golden mismatch for "${name}". If this change is intentional, run:\n  UPDATE_GOLDEN=1 npm test`
  )
}
