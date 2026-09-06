/**
 * Harness adapter: your projects directory.
 *
 * Every other adapter in here reads an agent harness's session files. This one has no
 * harness behind it at all — it reads the repos themselves and hands each one back shaped
 * like a thread, so a folder you have not opened an agent in still gets ground in the
 * colony. The point is coverage: a projects directory is mostly work you are *not* doing
 * this afternoon, and a map that only draws the live threads draws the smallest part of it.
 *
 * The mapping is the whole design, so it is written down rather than left to be inferred:
 *
 *   | Thread field     | Where it comes from                                              |
 *   | ---------------- | ---------------------------------------------------------------- |
 *   | one thread       | one local branch. A repo with three branches has a crew of three  |
 *   | `project`        | the folder's name — this is what claims a hex zone                |
 *   | `lastActivityAt` | the branch tip's commit date, or how recently you touched a file  |
 *   | `sizeBytes`      | tracked bytes at that branch's tip — how finished the building is |
 *   | `running`        | a tracked file changed in the last quarter hour                   |
 *   | `unread`         | **uncommitted changes, or commits you never pushed**              |
 *   | `hasError`       | a merge, rebase or bisect left half-done, or a detached HEAD      |
 *   | `model`          | the language most of the bytes are written in                     |
 *
 * `unread` is the one that earns this adapter its keep. In Claude Code a `?` means a thread
 * stopped and wants you; here it means work that is sitting in a working tree and has never
 * been put anywhere safe, which is the same question asked of a folder instead of a session.
 *
 * Read-only, without the asterisk the Claude Code adapter carries: this one has no archive
 * flag to set and never writes anything at all. See `README.md` in this directory.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { exists, listDirs, readHead } from '../lib/fsutil.mjs'

const execFileAsync = promisify(execFile)
const HOME = os.homedir()

/**
 * Where to look. `BOT_CROSSING_PROJECT_ROOTS` is a list in the platform's own path format
 * (`:` on unix, `;` on Windows — commas work everywhere), and overrides the guesses below.
 * The guesses are deliberately the boring ones; a root that is not there is simply skipped.
 */
const ROOTS_ENV = 'BOT_CROSSING_PROJECT_ROOTS'
const DEFAULT_ROOTS = ['Projects', 'projects', 'src', 'code', 'dev', 'repos', 'workspace', 'Developer']

/** Which editor the Open button hands the folder to. `auto` picks the first one installed. */
const OPEN_ENV = 'BOT_CROSSING_PROJECT_OPEN'

/** Folders with no `.git` at all still get an astronaut. Set to `0` to draw only repos. */
const PLAIN_ENV = 'BOT_CROSSING_PROJECT_PLAIN'

/**
 * Two caches, because the two halves of a repo change on completely different clocks.
 *
 * The *light* half — which branches exist, what is dirty, whether a rebase is half-done — can
 * change between one poll and the next, so it is re-read on a short TTL. The *heavy* half —
 * tracked bytes, language, the date of the root commit — cannot change without HEAD moving,
 * so it is keyed on HEAD's sha and skipped entirely while that holds still. Without the
 * split, `ls-tree` over a 69,000-file repo would run every few seconds forever.
 */
const LIGHT_TTL_MS = 8 * 1000
/** Walking a non-repo folder is the most expensive thing here and the least urgent. */
const PLAIN_TTL_MS = 5 * 60 * 1000
const cache = new Map()

/** A tracked file touched this recently means somebody is at that site right now. */
const ACTIVE_WINDOW_MS = 15 * 60 * 1000

/** Enough for `ls-tree` over a very large repo; the concurrency cap below bounds the total. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024
const GIT_TIMEOUT_MS = 20 * 1000
/** Git is process-per-call and a projects directory is hundreds of them. Four at a time. */
const CONCURRENCY = 4

/** Never walk into these looking for a folder's size — none of it is anybody's work. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', 'vendor', 'Pods', 'DerivedData', '.terraform', 'bin', 'obj',
])
const PLAIN_MAX_FILES = 20000
const PLAIN_MAX_DEPTH = 8

const LANGUAGES = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
  '.swift': 'Swift', '.m': 'Objective-C', '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++',
  '.hpp': 'C++', '.cs': 'C#', '.php': 'PHP', '.ps1': 'PowerShell', '.psm1': 'PowerShell',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.sql': 'SQL', '.r': 'R', '.lua': 'Lua',
  '.dart': 'Dart', '.ex': 'Elixir', '.exs': 'Elixir', '.scala': 'Scala', '.pl': 'Perl',
  '.vue': 'Vue', '.svelte': 'Svelte', '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS',
  '.md': 'Markdown', '.tf': 'Terraform', '.yml': 'YAML', '.yaml': 'YAML', '.json': 'JSON',
}
/** Markup and config are what a repo is *made of*, not what it is written in — last resort. */
const WEAK_LANGUAGES = new Set(['Markdown', 'YAML', 'JSON', 'HTML', 'CSS'])

/** Run `git` in a directory. Never throws: a repo we cannot read is a repo we skip a field on. */
async function git(dir, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args], {
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    return stdout
  } catch {
    return null
  }
}

/** Bounded-concurrency map. One rejection costs its own item and nothing else. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        out[i] = await fn(items[i])
      } catch {
        out[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function expandHome(p) {
  const t = p.trim()
  if (!t) return ''
  if (t === '~') return HOME
  return t.startsWith('~/') || t.startsWith('~\\') ? path.join(HOME, t.slice(2)) : t
}

function configuredRoots() {
  const raw = process.env[ROOTS_ENV]
  if (!raw) return DEFAULT_ROOTS.map((d) => path.join(HOME, d))
  // Split on the platform's own delimiter so a Windows `C:\…` keeps its colon, and on commas
  // as well because that is what everybody types when they have not thought about it.
  return raw
    .split(path.delimiter)
    .flatMap((part) => part.split(','))
    .map(expandHome)
    .filter(Boolean)
}

/**
 * The roots that are actually there, deduplicated by their real path. That last part is not
 * paranoia: the default list holds both `Projects` and `projects`, and on a case-insensitive
 * filesystem those are one directory — left alone every repo in it would be scanned twice.
 */
async function existingRoots() {
  const seen = new Map()
  for (const root of configuredRoots()) {
    try {
      const real = await fsp.realpath(root)
      const key = process.platform === 'linux' ? real : real.toLowerCase()
      if (!seen.has(key)) seen.set(key, real)
    } catch {
      /* not on this machine */
    }
  }
  return [...seen.values()]
}

/** `[ahead 2, behind 1]` — what `%(upstream:track)` says about a branch you have not pushed. */
function aheadOf(track) {
  const m = /ahead (\d+)/.exec(track || '')
  return m ? Number(m[1]) : 0
}

/** A merge or rebase left half-finished is the one genuinely stuck state a repo can be in. */
async function inProgress(dir) {
  const gitDir = path.join(dir, '.git')
  for (const [file, label] of [
    ['MERGE_HEAD', 'merge in progress'],
    ['rebase-merge', 'rebase in progress'],
    ['rebase-apply', 'rebase in progress'],
    ['CHERRY_PICK_HEAD', 'cherry-pick in progress'],
    ['REVERT_HEAD', 'revert in progress'],
    ['BISECT_LOG', 'bisect in progress'],
  ]) {
    if (await exists(path.join(gitDir, file))) return label
  }
  return ''
}

/** The first line of a README that is prose rather than a heading or a row of badges. */
async function readmeLine(dir) {
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.txt', 'README']) {
    const file = path.join(dir, name)
    if (!(await exists(file))) continue
    try {
      const head = await readHead(file, 8 * 1024)
      for (const raw of head.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#') || line.startsWith('!') || line.startsWith('[!')) continue
        if (line.startsWith('<') || line.startsWith('---') || line.startsWith('===')) continue
        return line.replace(/[*_`]/g, '').slice(0, 240)
      }
    } catch {
      /* unreadable — the folder still gets an astronaut */
    }
    return ''
  }
  return ''
}

/** Whichever language holds the most bytes, preferring code over the markup around it. */
function pickLanguage(bytesByLang) {
  let best = ''
  let bestBytes = -1
  for (const weak of [false, true]) {
    for (const [lang, bytes] of bytesByLang) {
      if (WEAK_LANGUAGES.has(lang) !== weak) continue
      if (bytes > bestBytes) {
        best = lang
        bestBytes = bytes
      }
    }
    if (best) return best
  }
  return best
}

/**
 * Tracked bytes and language at a commit, from one `ls-tree`. Both signals come out of the
 * same call because the expensive part is listing the tree, not reading the numbers off it.
 */
async function readTree(dir) {
  const out = await git(dir, ['ls-tree', '-r', '-l', 'HEAD'])
  if (!out) return { sizeBytes: 0, language: '' }

  let sizeBytes = 0
  const bytesByLang = new Map()
  for (const line of out.split('\n')) {
    // <mode> blob <sha> <size>\t<path> — size is `-` for a submodule or a symlink.
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const size = Number(line.slice(0, tab).trim().split(/\s+/)[3])
    if (!Number.isFinite(size)) continue
    sizeBytes += size
    const lang = LANGUAGES[path.extname(line.slice(tab + 1)).toLowerCase()]
    if (lang) bytesByLang.set(lang, (bytesByLang.get(lang) || 0) + size)
  }
  return { sizeBytes, language: pickLanguage(bytesByLang) }
}

/** When this repo started. The root commit, which is one cheap call and never moves. */
async function readBirth(dir) {
  const out = await git(dir, ['log', '--max-parents=0', '--format=%ct'])
  const first = (out || '').trim().split('\n').filter(Boolean).pop()
  return first ? Number(first) * 1000 : 0
}

/**
 * How recently you touched the working tree, which is the only activity a commit date cannot
 * see. Only the files git already told us are modified are stat'd, and only the first fifty:
 * this is a tiebreaker on an astronaut's pose, not a number worth a directory walk for.
 */
async function dirtyMtime(dir, files) {
  let newest = 0
  for (const rel of files.slice(0, 50)) {
    try {
      const st = await fsp.stat(path.join(dir, rel))
      if (st.mtimeMs > newest) newest = st.mtimeMs
    } catch {
      /* deleted, which is a change we already counted */
    }
  }
  return newest
}

/** `?? "a name with spaces"` — porcelain quotes a path only when it has to. */
function porcelainPaths(out) {
  const files = []
  for (const line of (out || '').split('\n')) {
    if (line.length < 4) continue
    let rel = line.slice(3)
    // A rename reads `old -> new`; the new name is the one on disk.
    const arrow = rel.lastIndexOf(' -> ')
    if (arrow >= 0) rel = rel.slice(arrow + 4)
    if (rel.startsWith('"') && rel.endsWith('"')) {
      try {
        rel = JSON.parse(rel)
      } catch {
        rel = rel.slice(1, -1)
      }
    }
    files.push(rel)
  }
  return files
}

/** One thread per local branch. */
async function gitThreads(dir, project, entry, now) {
  const [head, branchesOut, statusOut, stuck] = await Promise.all([
    git(dir, ['rev-parse', 'HEAD']),
    git(dir, [
      'for-each-ref',
      '--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)%09%(contents:subject)',
      'refs/heads',
    ]),
    git(dir, ['status', '--porcelain']),
    inProgress(dir),
  ])
  const headSha = (head || '').trim()
  const current = ((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim()
  const detached = current === 'HEAD'

  // Tracked bytes, language and birthday cannot change while HEAD does not, so they are
  // carried forward across every scan that finds the same sha.
  if (!entry.tree || entry.headSha !== headSha) {
    entry.tree = await readTree(dir)
    entry.birth = await readBirth(dir)
    entry.headSha = headSha
  }

  const dirtyFiles = porcelainPaths(statusOut)
  const touchedAt = dirtyFiles.length ? await dirtyMtime(dir, dirtyFiles) : 0
  const preview = await readmeLine(dir)

  const branches = (branchesOut || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, when, upstream, track, ...rest] = line.split('\t')
      return { name, when: Number(when) * 1000 || 0, upstream: upstream || '', track: track || '', subject: rest.join('\t') }
    })

  // Exactly one thread owns the working tree, and on a detached HEAD that is none of the
  // branches — so detaching would otherwise take the dirty-file signal off the whole repo,
  // which is precisely when you most want it. HEAD gets its own entry and owns it instead.
  if (detached) {
    const at = await git(dir, ['log', '-1', '--format=%ct%x09%s'])
    const [when, ...subject] = (at || '').trim().split('\t')
    branches.push({
      name: '',
      when: Number(when) * 1000 || 0,
      upstream: '',
      track: '',
      subject: subject.join('\t'),
      head: true,
    })
  } else if (!branches.length) {
    // A repo with no commits yet has nothing to enumerate. It still gets one astronaut: an
    // empty repo is somewhere you have started working, and its files are all untracked.
    branches.push({ name: current, when: 0, upstream: '', track: '', subject: '', head: true })
  }

  return branches.map((b) => {
    const checkedOut = b.head === true || (!detached && b.name === current)
    const ahead = aheadOf(b.track)
    const dirty = checkedOut ? dirtyFiles.length : 0
    const lastActivityAt = Math.max(b.when, checkedOut ? touchedAt : 0) || entry.mtime

    const waiting = []
    if (dirty) waiting.push(`${dirty} uncommitted file${dirty === 1 ? '' : 's'}`)
    if (ahead) waiting.push(`${ahead} unpushed commit${ahead === 1 ? '' : 's'}`)

    return {
      id: `git-repos:${dir}#${b.name || 'HEAD'}`,
      title: b.subject || `${project}${b.name ? ` · ${b.name}` : ''}`,
      preview: [waiting.join(', '), preview].filter(Boolean).join(' — '),
      project,
      projectPath: dir,
      worktree: '',
      cwd: dir,
      gitBranch: b.head && detached ? `detached at ${headSha.slice(0, 7)}` : b.name,
      model: entry.tree.language,
      effort: '',
      createdAt: entry.birth || lastActivityAt,
      lastActivityAt,
      lastFocusedAt: 0,
      // Somebody is at this site: the checked-out branch has changes you made minutes ago.
      running: checkedOut && dirty > 0 && now - touchedAt < ACTIVE_WINDOW_MS,
      // The `?` badge: work that exists only in this working tree, or only on this machine.
      unread: dirty > 0 || ahead > 0,
      hasError: checkedOut && Boolean(stuck || b.head === true && detached),
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: entry.tree.sizeBytes,
      source: 'git',
      canOpen: true,
      // Git has no archived state to flip, so the colony records it and the astronaut leaves.
      canArchive: false,
      ref: { path: dir, branch: b.name },
    }
  })
}

/** Everything under a folder that is not a repo — bytes, languages, and when you last saved. */
async function walkFolder(dir) {
  let sizeBytes = 0
  let files = 0
  let newest = 0
  const bytesByLang = new Map()

  const walk = async (current, depth) => {
    if (depth > PLAIN_MAX_DEPTH || files >= PLAIN_MAX_FILES) return
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files >= PLAIN_MAX_FILES) return
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        await walk(full, depth + 1)
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full)
          files += 1
          sizeBytes += st.size
          if (st.mtimeMs > newest) newest = st.mtimeMs
          const lang = LANGUAGES[path.extname(e.name).toLowerCase()]
          if (lang) bytesByLang.set(lang, (bytesByLang.get(lang) || 0) + st.size)
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }

  await walk(dir, 0)
  return { sizeBytes, files, newest, language: pickLanguage(bytesByLang) }
}

/** One thread for a folder with no git history at all. It has nothing to be waiting on. */
async function plainThread(dir, project, entry) {
  if (!entry.plain || Date.now() - entry.plainAt > PLAIN_TTL_MS) {
    entry.plain = await walkFolder(dir)
    entry.plainAt = Date.now()
  }
  const { sizeBytes, files, newest, language } = entry.plain
  if (!files) return []

  return [
    {
      id: `git-repos:${dir}#folder`,
      title: project,
      preview: (await readmeLine(dir)) || `${files.toLocaleString()} files, not under version control`,
      project,
      projectPath: dir,
      worktree: '',
      cwd: dir,
      gitBranch: '',
      model: language,
      effort: '',
      createdAt: newest || entry.mtime,
      lastActivityAt: newest || entry.mtime,
      lastFocusedAt: 0,
      running: false,
      // Deliberately not `unread`. A folder that was never a repo is not work you forgot to
      // push — it is work you never asked git about, and badging all of it buries the ones
      // that genuinely are one commit away from safe.
      unread: false,
      hasError: false,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes,
      source: 'folder',
      canOpen: true,
      canArchive: false,
      ref: { path: dir, branch: '' },
    },
  ]
}

/**
 * A bare repo — `something.git`, usually a local remote you push to — has no working tree and
 * is not a place you work. Left alone it reads as a folder and gets an astronaut standing on
 * a plot made of git's own object database. Recognised by shape rather than by name, because
 * the `.git` suffix is a convention and nothing enforces it.
 */
async function isBareRepo(dir) {
  const [head, objects, refs] = await Promise.all([
    exists(path.join(dir, 'HEAD')),
    exists(path.join(dir, 'objects')),
    exists(path.join(dir, 'refs')),
  ])
  return head && objects && refs
}

async function readProject(dir) {
  const project = path.basename(dir)
  if (project.startsWith('.')) return []

  const now = Date.now()
  let entry = cache.get(dir)
  if (!entry) {
    entry = { checkedAt: 0, headSha: '', tree: null, birth: 0, plain: null, plainAt: 0, mtime: 0, threads: [] }
    cache.set(dir, entry)
  }
  if (now - entry.checkedAt < LIGHT_TTL_MS) return entry.threads

  let stat
  try {
    stat = await fsp.stat(dir)
  } catch {
    cache.delete(dir)
    return []
  }
  entry.mtime = stat.mtimeMs
  entry.checkedAt = now

  const isRepo = await exists(path.join(dir, '.git'))
  if (!isRepo && (await isBareRepo(dir))) {
    entry.threads = []
    return entry.threads
  }
  if (isRepo) {
    entry.threads = await gitThreads(dir, project, entry, now)
  } else if (process.env[PLAIN_ENV] === '0') {
    entry.threads = []
  } else {
    entry.threads = await plainThread(dir, project, entry)
  }
  return entry.threads
}

async function scanThreads() {
  const roots = await existingRoots()
  const dirs = (await Promise.all(roots.map((r) => listDirs(r)))).flat()

  // Two roots can hand back the same folder — a symlink, or one root nested in another —
  // and two threads with one id would merge two unrelated repos onto one astronaut.
  const unique = new Map()
  for (const dir of dirs) {
    const key = process.platform === 'linux' ? dir : dir.toLowerCase()
    if (!unique.has(key)) unique.set(key, dir)
  }

  const lists = await mapLimit([...unique.values()], CONCURRENCY, readProject)
  return lists.filter(Boolean).flat()
}

/**
 * Which editor to hand a folder to. Checked once and remembered: this answers a click, and
 * the answer does not change while the colony is open.
 *
 * `vscode://file/<abs>` is VS Code's own "open this" scheme and Cursor kept the shape of it.
 * A path goes in as a URL path rather than through `URLSearchParams`, so its separators have
 * to survive: backslashes become forward ones and only the characters that must be escaped are.
 */
const EDITORS = {
  vscode: { scheme: 'vscode', apps: ['/Applications/Visual Studio Code.app', 'Microsoft VS Code', 'code'] },
  cursor: { scheme: 'cursor', apps: ['/Applications/Cursor.app', 'cursor', 'Cursor'] },
  windsurf: { scheme: 'windsurf', apps: ['/Applications/Windsurf.app', 'windsurf'] },
}

let openerCache = null
async function chooseOpener() {
  if (openerCache) return openerCache
  const wanted = (process.env[OPEN_ENV] || 'auto').toLowerCase()
  if (wanted !== 'auto') {
    openerCache = wanted
    return openerCache
  }
  for (const [name, { apps }] of Object.entries(EDITORS)) {
    for (const app of apps) {
      if (app.startsWith('/') && (await exists(app))) {
        openerCache = name
        return openerCache
      }
    }
  }
  // Nothing recognised, so fall back to the thing that is certainly installed if you are
  // running this at all: a fresh Claude Code session with the repo as its workspace.
  openerCache = 'claude'
  return openerCache
}

function fileUrl(scheme, dir) {
  const abs = dir.replace(/\\/g, '/')
  const rooted = abs.startsWith('/') ? abs : `/${abs}`
  return `${scheme}://file${rooted.split('/').map(encodeURIComponent).join('/')}`
}

async function openThread(ref) {
  const dir = ref?.path
  if (!dir) return { ok: false, error: 'No folder on that thread' }
  const opener = await chooseOpener()
  if (opener === 'none') return { ok: false, error: 'Opening is off — unset BOT_CROSSING_PROJECT_OPEN' }
  if (opener === 'claude') return newSession(dir)
  const editor = EDITORS[opener]
  if (!editor) return { ok: false, error: `Unknown ${OPEN_ENV}: ${opener}` }
  return { ok: true, url: fileUrl(editor.scheme, dir) }
}

/** The same `code/new?folder=` deep link every other adapter uses. Nothing is written. */
function newSession(dir) {
  return { ok: true, url: `claude://code/new?${new URLSearchParams({ folder: dir })}` }
}

/**
 * A repo has no archived list of its own, and inventing one would mean writing to somebody's
 * project to satisfy a viewer. Saying so is the documented answer: the colony records the
 * archive on its own side and the astronaut still walks back up the ramp.
 */
async function setArchived() {
  return { ok: false, error: 'A repo has no archived state of its own — hidden in the colony only' }
}

export default {
  id: 'git-repos',
  name: 'Projects',
  /** Only claim this machine if there is somewhere to look and something in it. */
  detect: async () => (await existingRoots()).length > 0,
  scanThreads,
  openThread,
  newSession,
  setArchived,
  paths: { roots: configuredRoots() },
}
