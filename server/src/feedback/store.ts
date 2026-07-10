import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RecommendationSnapshot } from './types.js'

const CACHE_DIR = process.env.AI_CACHE_DIR
  ? resolve(process.env.AI_CACHE_DIR)
  : resolve(process.cwd(), 'cache')

const DIR = join(CACHE_DIR, 'recommendations')
const FILE = join(DIR, 'snapshots.json')

let writeChain: Promise<void> = Promise.resolve()

async function ensureDir(): Promise<void> {
  await mkdir(DIR, { recursive: true })
}

export async function loadSnapshots(): Promise<RecommendationSnapshot[]> {
  try {
    const raw = await readFile(FILE, 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data as RecommendationSnapshot[]
  } catch {
    return []
  }
}

export async function saveSnapshots(rows: RecommendationSnapshot[]): Promise<void> {
  writeChain = writeChain.then(async () => {
    await ensureDir()
    await writeFile(FILE, JSON.stringify(rows, null, 2), 'utf8')
  })
  await writeChain
}

export function feedbackStorePath(): string {
  return FILE
}
