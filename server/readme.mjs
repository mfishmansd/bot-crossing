/**
 * A repo's own README, handed to the page as raw markdown.
 *
 * This is the one thing the colony reads out of a project folder that is not a session
 * record, and it exists because a zone with a name on it still does not say what the place
 * *is*. The astronaut standing on it can now answer that, and the sign at the gate says it
 * without being asked.
 *
 * Read-only, capped, and cached on the file's own mtime — a README does not change between
 * two polls fifteen seconds apart, and a colony of forty zones asks for forty of these
 * every time the page refreshes them.
 *
 * Rendering happens in the browser (`src/ui/markdown.js`). Nothing here interprets the
 * text: the server's whole job is to find the right file and refuse to read too much of it.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { readHead } from './lib/fsutil.mjs'

/** What a README is called. Matched against the directory listing, so casing is free. */
const README = /^readme(\.(md|markdown|mdown|mkd|txt|rst))?$/i

/** Where to look, in order. The two subfolders are where GitHub itself looks next. */
const SUBDIRS = ['', 'docs', '.github']

/**
 * A README longer than this is a book, and the sidebar it is going into is 320px across.
 * This is a ceiling on the *read* rather than on the file: nothing pulls a 4MB changelog
 * into memory to show its first screen.
 */
const LIMIT = 192 * 1024

/** Enough for every zone in a big colony, and bounded so a long session cannot grow it. */
const CACHE_MAX = 96
const cache = new Map()

/** `README.md` beats a bare `README`, whichever order the directory came back in. */
const rank = (name) => (/\.(md|markdown|mdown|mkd)$/i.test(name) ? 0 : /\.(txt|rst)$/i.test(name) ? 1 : 2)

async function findReadme(dir) {
  for (const sub of SUBDIRS) {
    const here = sub ? path.join(dir, sub) : dir
    let entries
    try {
      entries = await fsp.readdir(here, { withFileTypes: true })
    } catch {
      continue
    }
    const hits = entries.filter((e) => e.isFile() && README.test(e.name)).sort((a, b) => rank(a.name) - rank(b.name))
    if (hits.length) return path.join(here, hits[0].name)
  }
  return null
}

/**
 * The README for a folder, or `{ found: false }` if it has not got one — which is not an
 * error and must not read like one. Plenty of perfectly good repos have no README, and the
 * colony's answer for those is "nobody has written this place down", not a failure.
 */
export async function readReadme(dir) {
  const file = await findReadme(dir)
  if (!file) return { ok: true, found: false }

  const stat = await fsp.stat(file).catch(() => null)
  if (!stat || !stat.isFile()) return { ok: true, found: false }

  // Keyed on what the file *is* rather than on where it is: an edit moves the mtime and
  // misses the cache, and nothing else does.
  const key = `${file} ${stat.mtimeMs} ${stat.size}`
  const hit = cache.get(key)
  if (hit) return hit

  let text
  try {
    text = await readHead(file, LIMIT)
  } catch {
    return { ok: true, found: false }
  }

  const result = {
    ok: true,
    found: true,
    file: path.relative(dir, file),
    text,
    truncated: stat.size > LIMIT,
    modifiedAt: stat.mtimeMs,
  }
  cache.set(key, result)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return result
}
