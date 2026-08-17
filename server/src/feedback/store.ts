import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RecommendationSnapshot } from './types.js'

function cacheDir(): string {
  return process.env.AI_CACHE_DIR
    ? resolve(process.env.AI_CACHE_DIR)
    : resolve(process.cwd(), 'cache')
}

function dir(): string {
  return join(cacheDir(), 'recommendations')
}

function file(): string {
  return join(dir(), 'snapshots.json')
}

/** Rolling copies kept next to snapshots.json (`snapshots.bak-<ms>.json`). */
const KEEP_BACKUPS = 5

/** Larger than a literal `[]` / whitespace — nonempty history must not look empty. */
const EMPTY_FILE_MAX_BYTES = 16

let writeChain: Promise<void> = Promise.resolve()

export class SnapshotStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'SnapshotStoreError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

async function ensureDir(): Promise<void> {
  await mkdir(dir(), { recursive: true })
}

/**
 * Load the snapshot book.
 *   - missing file → []
 *   - unreadable / invalid JSON / not an array → throw (never pretend empty)
 */
export async function loadSnapshots(): Promise<RecommendationSnapshot[]> {
  try {
    const raw = await readFile(file(), 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) {
      throw new SnapshotStoreError(`snapshots.json is not an array (${file()})`)
    }
    return data as RecommendationSnapshot[]
  } catch (err) {
    if (err instanceof SnapshotStoreError) throw err
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw new SnapshotStoreError(`failed to load snapshots from ${file()}`, { cause: err })
  }
}

/**
 * Guard for replace-today writers: if the on-disk file is nonempty but load
 * returned [], treating that as "no history" would wipe the book. Call after
 * a successful load before concatenating a new day's rows.
 */
export async function assertLoadedHistoryMatchesFile(
  loaded: RecommendationSnapshot[]
): Promise<void> {
  if (loaded.length > 0) return
  try {
    const st = await stat(file())
    if (st.size > EMPTY_FILE_MAX_BYTES) {
      throw new SnapshotStoreError(
        `refusing to treat nonempty snapshots.json (${st.size} bytes) as empty history (${file()})`
      )
    }
  } catch (err) {
    if (err instanceof SnapshotStoreError) throw err
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

async function rotateBackup(): Promise<void> {
  const src = file()
  try {
    await copyFile(src, join(dir(), `snapshots.bak-${Date.now()}.json`))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const names = (await readdir(dir()))
    .filter((n) => /^snapshots\.bak-\d+\.json$/.test(n))
    .sort()
  const stale = names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))
  await Promise.all(stale.map((n) => unlink(join(dir(), n)).catch(() => {})))
}

export async function saveSnapshots(rows: RecommendationSnapshot[]): Promise<void> {
  writeChain = writeChain.then(async () => {
    await ensureDir()
    await rotateBackup()
    const dest = file()
    const tmp = `${dest}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8')
    await rename(tmp, dest)
  })
  await writeChain
}

export function feedbackStorePath(): string {
  return file()
}
