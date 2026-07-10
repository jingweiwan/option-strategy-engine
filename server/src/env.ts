/**
 * Tiny .env loader. Reads server/.env (or path from ENV_FILE) and copies
 * each KEY=VALUE pair into process.env, without overwriting existing vars.
 * No external deps.
 *
 * IMPORTANT: this runs as a side effect at module-load time. Always import
 * this BEFORE any module that reads process.env at module init:
 *
 *   import './env.js'                // first
 *   import Fastify from 'fastify'    // then everything else
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnv(): void {
  const envFile = process.env.ENV_FILE ?? '.env'
  const path = resolve(process.cwd(), envFile)
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return // .env is optional
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadEnv()
