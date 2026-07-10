/**
 * Reader for the daily chain archive written by api/chainArchive.ts.
 * Layout: data/chains/YYYY-MM-DD/SYM.json.gz, each holding
 *   { symbol, day, archivedAt, payload: <raw CBOE data> }
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE_DIR = join(__dirname, '..', '..', 'data', 'chains')

export type ArchivedChain = { symbol: string; day: string; payload: unknown }

/** Archive day-directories in chronological order. */
export function listArchiveDays(): string[] {
  if (!existsSync(BASE_DIR)) return []
  return readdirSync(BASE_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
}

export function listArchivedSymbols(day: string): string[] {
  const dir = join(BASE_DIR, day)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json.gz'))
    .map((f) => f.replace(/\.json\.gz$/, ''))
    .sort()
}

/** Load + decompress one archived chain; null on missing/corrupt. */
export function loadArchivedChain(day: string, symbol: string): ArchivedChain | null {
  const file = join(BASE_DIR, day, `${symbol.toUpperCase()}.json.gz`)
  if (!existsSync(file)) return null
  try {
    const rec = JSON.parse(gunzipSync(readFileSync(file)).toString()) as ArchivedChain
    if (!rec || rec.payload == null) return null
    return rec
  } catch {
    return null
  }
}
