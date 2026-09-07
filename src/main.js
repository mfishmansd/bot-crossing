import * as THREE from 'three'
import './ui/styles.css'
import { DEFAULT_PRESET, Settings, hasStoredSettings } from './core/settings.js'
import { Engine } from './core/engine.js'
import { CameraRig } from './core/camera.js'
import { Colony, STATUS_LABEL, STATUS_ORDER, statusFor, transcriptProgress } from './game/colony.js'
import { Hud } from './ui/hud.js'
import { PLANETS } from './world/planet.js'
import { loadKit } from './world/kit.js'
import { crewRig, loadCrew } from './agents/crew.js'
import { TIMES } from './world/sky.js'
import {
  fetchThreads,
  fetchState,
  saveState,
  openThread,
  archiveThread,
  newSession,
  revealFolder,
  fetchReadme,
} from './game/api.js'
import { renderMarkdown, readmeSummary } from './ui/markdown.js'

/**
 * Boot and the outer game loop.
 *
 * The one interesting piece of orchestration here is the archive round trip. The harness
 * owns the session records; the colony owns nothing but its own list of what you archived,
 * and that list is written by exactly one writer — this page — so a save from a stale tab
 * can never silently drop an archive. Everything else is wiring.
 */

const POLL_MS = 15000
const app = document.getElementById('app')

app.insertAdjacentHTML(
  'beforeend',
  `<div class="boot"><div class="inner">
     <h1>Bot Crossing</h1>
     <p>Scanning for agent threads…</p>
     <div class="bar"><i></i></div>
   </div></div>`
)

const settings = new Settings()
if (!hasStoredSettings()) settings.applyPreset(DEFAULT_PRESET)

const engine = new Engine(settings).mount(app)
const rig = new CameraRig(engine.camera, engine.canvas, settings)
const colony = new Colony(engine.scene, settings, engine.camera, engine.renderer)
// The badge on your own pack. Served from a gitignored folder: it is your mark, and the
// repository is public. If the file is not there you get a plain P and nothing breaks.
colony.astronauts.setLogo(`${import.meta.env.BASE_URL}assets/local/privion-mark.svg`)

let state = { archived: [], archivedAt: {}, opened: [], plots: {}, seen: {} }
let threads = []
/** Last legend built for the bottom bar, kept so the open zone's chip can light up between polls. */
let legendProjects = []
/** The zone layout as last written to the colony file, so an unchanged map is not re-saved. */
let lastLayout = ''
let selectedId = null
/** Which zone's sidebar is open. A repo, not a thread — they outlive the threads on them. */
let selectedProject = null
let hoverId = null
/** Which astronaut you are steering, if any. See `startWalk`. */
let walkingId = null
/** Movement keys currently down. A Set rather than flags so a key repeat cannot double up. */
const held = new Set()
/** Every README summary read this session, by folder. See `readmeFor`. */
const readmes = new Map()
/** The rendered body of the *open* repo's readme, and only that one. See `readmePanel`. */
let panelReadme = null
let statusCursor = 0
let pendingSave = 0
const hoverGround = new THREE.Vector3()

// ── actions the HUD can trigger ────────────────────────────────────────────────────────

const actions = {
  resetView: () => rig.resetView(),

  screenshot: () => {
    // Render one more frame, then read the buffer before the compositor clears it — the
    // alternative is preserveDrawingBuffer, which costs a copy on every single frame.
    engine.renderFrame()
    const url = engine.canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `bot-crossing-${colony.planet.id}-${stamp()}.png`
    a.click()
    hud.toast('Screenshot saved')
  },

  /**
   * Take one astronaut off its errands and walk it about yourself.
   *
   * Whoever is selected, or failing that whoever is nearest the middle of the view — asking
   * you to pick somebody first would make the mode two steps, and the whole appeal of it is
   * that it is one.
   */
  toggleWalk: () => {
    if (walkingId) {
      stopWalk()
      return
    }
    const agent = colony.agentFor(selectedId) || nearestAgent()
    if (!agent) {
      hud.toast('Nobody is out on the surface to walk', 'err')
      return
    }
    startWalk(agent)
  },

  /** Google Earth's auto-rotate: a slow sweep around whatever is centred. */
  toggleOrbit: () => {
    const on = rig.toggleOrbit()
    hud.hint(on ? 'Orbit mode on — drag or press O to stop' : 'Orbit mode off')
    return on
  },

  cyclePlanet: () => {
    const ids = Object.keys(PLANETS)
    const next = ids[(ids.indexOf(settings.get('planet')) + 1) % ids.length]
    settings.set('planet', next)
    hud.hint(`${PLANETS[next].name} — ${PLANETS[next].blurb}`)
  },

  cycleTime: () => {
    settings.set('autoTime', false)
    const current = settings.get('timeOfDay')
    // Step to the next named time *after* the current one, wrapping at midnight.
    const next = TIMES.find((t) => t.value > current + 0.005) || TIMES[0]
    settings.set('timeOfDay', next.value)
    hud.hint(next.label)
  },

  /** Fly to the next astronaut in a given state, cycling through them on repeat presses. */
  focusStatus: (status) => {
    const key = status === 'agents' ? null : status
    const pool = colony.astronauts.agents.filter((a) => (key ? a.status === key : true))
    if (!pool.length) {
      hud.hint(key ? `Nobody is ${(STATUS_LABEL[key] || key).toLowerCase()} right now` : 'No crew on the surface')
      return
    }
    pool.sort((a, b) => a.id.localeCompare(b.id))
    const agent = pool[statusCursor++ % pool.length]
    select(agent.id, { fly: true })
  },

  focusProject: (name) => {
    const plot = colony.plots.get(name)
    if (!plot) return
    rig.focus(plot.middle || plot.center, { distance: 30 })
  },

  /** The legend, and anything else that means "show me this repo". */
  pickProject: (name) => selectProject(name, { fly: true }),

  /** Back out of one repo to the list of all of them. The panel itself never leaves. */
  closeProject: () => {
    selectedProject = null
    select(null, {})
    syncProject()
  },

  select: (id) => select(id, {}),

  focusThread: (id) => select(id, { fly: true }),

  /**
   * A new thread in this repo. The desktop app opens an empty session with the folder as
   * its workspace — nothing here is resumed, and nothing is written to disk.
   */
  newConversation: async () => {
    const name = selectedProject
    const folder = name && pathForProject(name)
    if (!folder) {
      hud.toast('No folder on disk for that project', 'err')
      return
    }
    try {
      const harness = harnessForProject(name)
      await newSession(folder, harness)
      hud.toast(`New thread in ${name} — opening ${harnessLabel(harness)}`)
      // It lands as an astronaut walking down the ramp, once it has a record to scan.
      setTimeout(poll, 6000)
    } catch (err) {
      hud.toast(err.message || 'Could not start a thread there', 'err')
    }
  },

  revealProject: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    try {
      await revealFolder(folder)
    } catch (err) {
      hud.toast(err.message || 'Could not open that folder', 'err')
    }
  },

  copyProjectPath: async () => {
    const folder = selectedProject && pathForProject(selectedProject)
    if (!folder) return
    try {
      await navigator.clipboard.writeText(folder)
      hud.toast('Path copied')
    } catch {
      // The async clipboard needs a permission this page does not always have — inside an
      // embedded preview, say. The old selection-based copy has no such gate.
      const copied = copyFallback(folder)
      hud.toast(copied ? 'Path copied' : 'Could not reach the clipboard', copied ? '' : 'err')
    }
  },

  openThread: async (which = threads.find((t) => t.id === selectedId)) => {
    const thread = which
    if (!thread) return
    try {
      await openThread(thread)
      colony.astronauts.celebrate(thread.id)
      hud.toast(`Opened in ${thread.harnessName || 'your harness'}`)
      // Opening is the thing that makes a thread no longer unread, so refresh shortly after.
      setTimeout(poll, 1800)
    } catch (err) {
      hud.toast(err.message || 'Could not open that thread', 'err')
    }
  },

  archiveThread: async (which = threads.find((t) => t.id === selectedId)) => {
    const thread = which
    if (!thread) return
    try {
      const res = await archiveThread(thread, true)
      state.archived = [...new Set([...state.archived, thread.id])]
      state.archivedAt = { ...state.archivedAt, [thread.id]: Date.now() }
      queueSave()
      select(null, {})
      applyThreads(threads)
      hud.toast(
        res.harnessRecord === false
          ? `Archived here (no ${thread.harnessName || 'harness'} record for it)`
          : 'Archived — heading home'
      )
      colony.ship.ping()
    } catch (err) {
      hud.toast(err.message || 'Could not archive that thread', 'err')
    }
  },

  uiVisibility: (visible) => colony.setUiVisible(visible),

  // The card's bar is about the *thread*, not about how much of its building has risen —
  // those were the same number while construction was drawn by burying the structure.
  progressFor: (id) => {
    const thread = threads.find((t) => t.id === id)
    return thread ? transcriptProgress(thread) : 0
  },
}

// A zone close enough to carry a sign wants the readme behind it. Asked for from here
// rather than fetched by the colony, which knows about distances and nothing about servers.
colony.onReadmeWanted = (name) => {
  const path = pathForProject(name)
  if (path) readmeFor(path, name)
  else colony.setReadme(name, null)
}

const hud = new Hud(app, settings, actions)
// The sidebar is permanent, so the card beside an astronaut has a wall to stay clear of.
const sideWidth = () => (window.innerWidth <= 820 ? 0 : 334)
hud.setSideWidth(sideWidth())
window.addEventListener('resize', () => hud.setSideWidth(sideWidth()))

// ── selection ─────────────────────────────────────────────────────────────────────────

function select(id, { fly = false } = {}) {
  selectedId = id
  const agent = id ? colony.agentFor(id) : null
  if (!agent) {
    selectedId = null
    colony.astronauts.setSelected(null)
    hud.setSelection(null, null)
    syncProject()
    return
  }
  colony.astronauts.setSelected(agent)
  const thread = threads.find((t) => t.id === id) || agent.thread
  hud.setSelection(agent, thread)
  // Picking somebody is also picking the zone they are standing on: the sidebar follows.
  if (thread?.project && colony.plots.has(thread.project)) selectedProject = thread.project
  syncProject()
  if (fly) {
    rig.focus(new THREE.Vector3(agent.pos.x, 0, agent.pos.z), { distance: Math.min(rig.desiredDistance, 26) })
  }
}

/** Open a zone's sidebar. Any selected astronaut from a different zone lets go. */
function selectProject(name, { fly = false } = {}) {
  if (!name || !colony.plots.has(name)) return
  selectedProject = name
  const current = threads.find((t) => t.id === selectedId)
  if (current && current.project !== name) select(null, {})
  else syncProject()
  if (fly) actions.focusProject(name)
}

/**
 * The repo folder behind a zone. Plots are keyed by the folder's *name*, which is all the
 * colony needs to draw one — the path itself lives on the threads, so it is read back off
 * them, taking the most common answer if two checkouts somehow share a basename.
 */
/** The human name for a harness id — every thread already carries its own. */
function harnessLabel(id) {
  for (const thread of colony.threads.values()) {
    if (thread.harness === id && thread.harnessName) return thread.harnessName
  }
  return 'your harness'
}

/**
 * Which harness a project's threads belong to, picked the same way its path is: the most
 * common answer among the threads standing there. A repo worked on from two harnesses gets
 * a new thread in whichever one it is mostly used from.
 */
function harnessForProject(name) {
  const counts = new Map()
  for (const thread of colony.threads.values()) {
    if (thread.project !== name || !thread.harness) continue
    counts.set(thread.harness, (counts.get(thread.harness) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [id, n] of counts) {
    if (n <= bestCount) continue
    best = id
    bestCount = n
  }
  return best
}

function pathForProject(name) {
  const counts = new Map()
  for (const thread of colony.threads.values()) {
    if (thread.project !== name) continue
    const dir = thread.projectPath || thread.cwd
    if (!dir) continue
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [dir, n] of counts) {
    if (n <= bestCount) continue
    best = dir
    bestCount = n
  }
  return best
}

/**
 * A repo's README, in the two sizes the colony reads it at.
 *
 * `readmeFor` is the cheap one: a title and an opening line, for the sign on the plot and
 * for the sentence the astronaut says. It is kept for every folder that has ever been near
 * the camera, which is a few hundred bytes each and no markup at all.
 *
 * `readmePanel` is the expensive one — the whole document, rendered — and exactly one is
 * held at a time, for whichever repo's sidebar is open. Rendering every README a session
 * touches and keeping them all would be tens of megabytes of DOM strings to show one.
 *
 * Both are fire-and-forget: they hand back what is known *now*, usually "reading…" on the
 * first call, and repaint when the answer lands.
 */
const README_TTL = 5 * 60 * 1000

function readmeFor(folder, name) {
  if (!folder) return null

  const held = readmes.get(folder)
  // Marked as in-flight *before* the request goes out, so the sign sweep asking again half
  // a second later does not start a second read of the same file.
  if (held && Date.now() - held.at < README_TTL) return held
  const entry = held || { state: 'loading', summary: null }
  entry.at = Date.now()
  readmes.set(folder, entry)

  fetchReadme(folder)
    .then((res) => {
      const summary = res.found ? readmeSummary(res.text, name) : null
      readmes.set(folder, { state: res.found ? 'ready' : 'none', summary, at: Date.now() })
      colony.setReadme(name, summary)
    })
    .catch(() => {
      // Told as "no readme" rather than left unanswered: an unanswered zone is one the
      // sweep asks about again on every pass, for as long as you stand near it.
      readmes.set(folder, { state: 'error', summary: null, at: Date.now() })
      colony.setReadme(name, null)
    })

  return entry
}

function readmePanel(folder) {
  if (!folder) return { state: 'none', key: '' }
  if (panelReadme?.folder === folder) return panelReadme

  panelReadme = { folder, state: 'loading', key: '' }
  fetchReadme(folder)
    .then((res) => {
      // The panel may have moved on to another repo while this was in the air.
      if (panelReadme?.folder !== folder) return
      panelReadme = {
        folder,
        state: res.found ? 'ready' : 'none',
        key: `${res.file || ''}:${res.modifiedAt || 0}`,
        html: res.found ? renderMarkdown(res.text) : '',
      }
      syncProject()
    })
    .catch((err) => {
      if (panelReadme?.folder !== folder) return
      panelReadme = { folder, state: 'error', key: 'err', error: err.message }
      syncProject()
    })

  return panelReadme
}

/** Push the open zone's current contents at the sidebar. Closes it if the zone is gone. */
function syncProject() {
  const plot = selectedProject ? colony.plots.get(selectedProject) : null
  if (!plot) {
    selectedProject = null
    hud.setProject(null)
    hud.setLegend(legendProjects, null)
    return
  }
  const now = Date.now()
  const list = [...colony.threads.values()]
    .filter((thread) => thread.project === plot.name)
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      worktree: thread.worktree,
      lastActivityAt: thread.lastActivityAt,
      status: statusFor(thread, now),
    }))
    // Whoever wants something first, then most recently touched — the same order of
    // importance the badges use above their heads.
    .sort((a, b) => {
      const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
      return rank || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })

  const path = pathForProject(plot.name)
  hud.setProject({
    name: plot.name,
    accent: plot.accent,
    path,
    threads: list,
    selectedId,
    readme: { ...readmePanel(path), summary: readmes.get(path)?.summary || null },
  })
  // The legend is the same selection seen from the bottom of the screen: keep it in step
  // here rather than only on the next poll.
  hud.setLegend(legendProjects, selectedProject)
}

// ── walking one of them yourself ──────────────────────────────────────────────────────

/**
 * Walk mode: the colony from the deck rather than from orbit.
 *
 * Almost none of it is new machinery. The astronaut is one of the crew with its own state
 * machine suspended (`astronauts.drive`), collision is the same nav grid every other
 * astronaut is already sliding against, and the camera is the same rig with its target
 * pinned to a moving point instead of a still one. What is genuinely new is only this: a set
 * of held keys, turned into a direction in the camera's frame.
 *
 * Movement is camera-relative — W is *away from the camera*, not north — because the camera
 * can be spun to any heading and a fixed compass would have you pressing different keys to
 * walk the same way depending on where you happened to have dragged the view.
 */
const WALK_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', ' '])
/**
 * How close to the foot of the ramp counts as standing at the hatch.
 *
 * You board by pressing a key here rather than by walking up the ramp, because an
 * astronaut's height comes from the terrain sampler and the ramp is not terrain — climbing
 * it is a physics problem of its own, and not the one this feature is.
 */
const HATCH_RANGE = 3.2
/** Whether the prompt is currently showing, so it is written once rather than every frame. */
let atHatch = false
/**
 * Aboard: the panel in the middle of the view, and the one that is about to be. A panel has
 * to hold the centre for a few frames before it counts, or a drag across the wall would
 * change the sidebar forty times on its way past — the dead zone is time, not angle.
 */
let deckFacing = -1
let deckCandidate = -1
let deckCandidateFrames = 0
/**
 * The sweep: archiving everything in a repo — or the colony — that has sat idle for longer
 * than this. Two presses, because it is the one thing in the game that touches many
 * records at once; and it is undoable, because the archive call takes a boolean.
 */
const SWEEP_DAYS = 30
const SWEEP_MS = SWEEP_DAYS * 24 * 60 * 60 * 1000
/** A sweep waiting for its second press: what it would archive, and when it was offered. */
let sweepArmed = null
/** The threads the last sweep archived, so U can put them back. */
let lastSweep = null

/**
 * Whoever is nearest the middle of the view. Size is deliberately not a filter: from the
 * map's height every astronaut is drawn at LOD scale zero, and a version of this that
 * skipped small ones answered "nobody is out on the surface" from exactly the view you are
 * usually in — which made the one key that starts walking, flying and the deck fail by
 * default. The camera knows how to fly down to whoever is picked.
 */
function nearestAgent() {
  let best = null
  let bestD = Infinity
  for (const agent of colony.astronauts.agents) {
    if (agent.state === 'leaving' || agent.state === 'gone') continue
    const d = (agent.pos.x - rig.target.x) ** 2 + (agent.pos.z - rig.target.z) ** 2
    if (d < bestD) {
      bestD = d
      best = agent
    }
  }
  return best
}

function startWalk(agent) {
  if (!colony.astronauts.drive(agent.id)) return
  walkingId = agent.id
  held.clear()
  rig.setWalking(true)
  // Name plates stop floating over the scene and take their place in it — see the colony.
  colony.setLabelsInWorld(true)
  // The shallow focus is what makes the colony a model on a table; from inside it, it is
  // just fog a few metres out.
  engine.setFocusScale(0.3)
  // Not snapped: the camera flies down out of the map, which is both nicer to watch and the
  // clearest possible statement of which of the four hundred little figures is now you.
  rig.follow(agent.pos)
  select(agent.id, {})
  hud.setWalking(agent.thread?.title || agent.id)
  hud.hint('WASD or arrows to walk · shift to run · space to hop, hold it to fly · Esc to let go')
}

function stopWalk() {
  if (!walkingId) return
  // Letting go while aboard would strand the astronaut on a deck six hundred units under
  // the colony, walking its errands underground for the rest of the session.
  if (colony.aboard) colony.leaveShip()
  rig.setInterior(null)
  colony.deck.setFocused(-1)
  deckFacing = deckCandidate = -1
  atHatch = false
  walkingId = null
  held.clear()
  colony.astronauts.release()
  rig.setWalking(false)
  colony.setLabelsInWorld(false)
  engine.setFocusScale(1)
  hud.setWalking(null)
}

// The astronaut can be taken back out of your hands — its thread archived, or gone from a
// scan — and when it is, the page has to put the camera back rather than follow a ghost.
colony.astronauts.onReleased = () => {
  if (!walkingId) return
  if (colony.aboard) colony.leaveShip()
  rig.setInterior(null)
  colony.deck.setFocused(-1)
  deckFacing = deckCandidate = -1
  atHatch = false
  walkingId = null
  rig.setWalking(false)
  colony.setLabelsInWorld(false)
  engine.setFocusScale(1)
  hud.setWalking(null)
  hud.toast('That thread has finished — you are back on the map')
}

/**
 * Offer the hatch when you are stood at it, and take the offer back when you walk away.
 * Written only on the edges: a hint rewritten sixty times a second is a hint that cannot be
 * replaced by anything else the colony wants to say to you.
 */
function updateHatchPrompt() {
  if (!walkingId || colony.aboard) {
    atHatch = false
    return
  }
  const agent = colony.astronauts.driven
  if (!agent) return
  const door = colony.ship.shipDoor(_hatch)
  const near = Math.hypot(agent.pos.x - door.x, agent.pos.z - door.z) < HATCH_RANGE
  if (near === atHatch) return
  atHatch = near
  hud.hint(near ? 'E to go aboard' : 'WASD or arrows to walk · shift to run · space to hop, hold it to fly · Esc to let go')
}
const _hatch = new THREE.Vector3()

/**
 * Aboard, looking at a panel is selecting its repo.
 *
 * The sidebar follows the middle of the view exactly as it follows a click on a zone, so
 * every key that works on the map works from in here on whatever you are looking at. The
 * deck never grows a second way of doing anything; it is another way of pointing.
 */
function updateDeckFacing() {
  if (!colony.aboard) return
  const panel = colony.deck.facing(rig.target, rig.azimuth, rig.polar)
  if (panel !== deckCandidate) {
    deckCandidate = panel
    deckCandidateFrames = 0
    return
  }
  if (++deckCandidateFrames < 6 || panel === deckFacing) return
  deckFacing = panel
  colony.deck.setFocused(panel)
  const entry = colony.deck.entryAt(panel)
  if (!entry) {
    // A dark panel, or the gap above the top row: the console shows the colony instead.
    colony.deck.setConsole(colony.consoleSummary())
    return
  }
  sweepArmed = null
  colony.deckCursor = 0
  selectProject(entry.project)
  // The console follows the facing repo. Asking for its readme goes through the same
  // loader the surface boards use, so a repo you have already stood near costs nothing.
  readmeFor(pathForProject(entry.project), entry.project)
  colony.deck.setConsole(colony.consoleFor(entry.project))
  hud.hint(`${entry.project} · [ ] pick · Enter opens · A archive · C new · X sweep idle · F folder · N next · E leave`)
}

/**
 * The thread the console has picked in the facing repo. The queue is worst first and the
 * pick starts at the top, so with no keys pressed this is the one that most needs you —
 * and [ and ] walk it down the list.
 */
function facingThread() {
  const entry = colony.aboard ? colony.deck.entryAt(deckFacing) : null
  if (!entry) return null
  const info = colony.consoleFor(entry.project)
  const row = info.threads[info.cursor]
  return row ? threads.find((t) => t.id === row.id) || null : null
}

/** [ and ], aboard: move the pick through the facing repo's queue and redraw it. */
function moveDeckPick(delta) {
  const entry = colony.deck.entryAt(deckFacing)
  if (!entry) {
    hud.hint('Look at a repo first')
    return
  }
  const info = colony.consoleFor(entry.project)
  colony.deckCursor = Math.max(0, Math.min(info.cursor + delta, info.threads.length - 1))
  colony.deck.setConsole(colony.consoleFor(entry.project))
}

/** N, aboard: turn to the next panel that wants you instead of flying off the deck. */
function turnToNextUrgent() {
  const panel = colony.deck.nextUrgent(deckFacing)
  if (panel < 0) {
    hud.hint('Nothing on the wall needs you')
    return
  }
  rig.turnTo(colony.deck.panelCenter(panel, _hatch))
}

/**
 * What a sweep would archive. Only threads that are genuinely asleep — nothing running,
 * nothing waiting on you, nothing stuck — and only ones the harness will let go of. The
 * archived flag on a thread means the harness already has it put away; the colony's own
 * list means you did.
 */
function sweepCandidates(project) {
  const now = Date.now()
  const done = new Set(state.archived)
  return threads.filter(
    (t) =>
      (!project || t.project === project) &&
      !t.archived &&
      !done.has(t.id) &&
      t.canArchive !== false &&
      !t.running &&
      !t.unread &&
      !t.hasError &&
      now - t.lastActivityAt > SWEEP_MS
  )
}

/**
 * X, aboard. Facing a repo it offers to sweep that repo; facing nothing it offers the
 * colony. The first press says what it would do and how much; the second, inside eight
 * seconds, does it. Anything else in between — turning to another panel, say — takes the
 * offer off the table rather than leaving a loaded key behind you.
 */
function armOrRunSweep() {
  const entry = colony.deck.entryAt(deckFacing)
  const scope = entry ? entry.project : null
  const list = sweepCandidates(scope)
  const where = scope || 'the colony'
  if (!list.length) {
    sweepArmed = null
    hud.hint(`Nothing in ${where} has been idle over ${SWEEP_DAYS} days`)
    return
  }
  const armed = sweepArmed && sweepArmed.scope === scope && Date.now() - sweepArmed.at < 8000
  if (!armed) {
    sweepArmed = { scope, at: Date.now() }
    hud.hint(`Archive ${list.length} thread${list.length === 1 ? '' : 's'} idle over ${SWEEP_DAYS} days in ${where}? X again to confirm`)
    return
  }
  sweepArmed = null
  runSweep(list, where)
}

/**
 * Archive a list of threads, a few at a time, and tell the colony once. The per-thread
 * action re-lays the colony after every call; a hundred of those in a row would re-lay it a
 * hundred times to arrive at the same map.
 */
async function runSweep(list, where) {
  hud.hint(`Archiving ${list.length} in ${where}…`)
  const done = []
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const thread = list[next++]
      try {
        await archiveThread(thread, true)
        done.push(thread)
      } catch {
        // One refusal is not a reason to stop the rest; it is simply not in `done`.
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  if (!done.length) {
    hud.toast(`Could not archive anything in ${where}`, 'err')
    return
  }
  const at = Date.now()
  state.archived = [...new Set([...state.archived, ...done.map((t) => t.id)])]
  state.archivedAt = { ...state.archivedAt, ...Object.fromEntries(done.map((t) => [t.id, at])) }
  queueSave()
  applyThreads(threads)
  lastSweep = done
  colony.ship.ping()
  hud.toast(`Archived ${done.length} in ${where} · U to undo`)
}

/** U, aboard: put the last sweep back. The same call with the other boolean. */
async function undoSweep() {
  if (!lastSweep || !lastSweep.length) {
    hud.hint('Nothing to undo')
    return
  }
  const list = lastSweep
  lastSweep = null
  hud.hint(`Restoring ${list.length}…`)
  const back = []
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const thread = list[next++]
      try {
        await archiveThread(thread, false)
        back.push(thread.id)
      } catch {
        // Left archived, and said so in the count below.
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  const gone = new Set(back)
  state.archived = state.archived.filter((id) => !gone.has(id))
  state.archivedAt = Object.fromEntries(Object.entries(state.archivedAt).filter(([id]) => !gone.has(id)))
  queueSave()
  applyThreads(threads)
  hud.toast(back.length === list.length ? `Restored ${back.length}` : `Restored ${back.length} of ${list.length}`)
}

/** Aboard, or back out. The camera is snapped rather than flown; the deck is a long way down. */
function toggleAboard() {
  if (!walkingId) return
  if (colony.aboard) {
    const agent = colony.leaveShip()
    if (agent) {
      deckFacing = deckCandidate = -1
      colony.deck.setFocused(-1)
      select(walkingId, {})
      rig.setInterior(null)
      rig.snapTo(agent.pos)
      engine.setFocusScale(0.3)
      hud.hint('Back on the surface · E at the ramp to go aboard again')
    }
    return
  }
  const agent = colony.astronauts.driven
  if (!agent) return
  const door = colony.ship.shipDoor(_hatch)
  if (Math.hypot(agent.pos.x - door.x, agent.pos.z - door.z) > HATCH_RANGE) return
  const aboard = colony.boardShip()
  if (!aboard) return
  rig.setInterior(colony.deck.cameraBounds())
  rig.snapTo(aboard.pos)
  // Nearly off. The shallow focus is what makes the colony read as a model on a table, and
  // indoors it has nothing left to do but blur the wall you came in to read — this was set
  // to full strength, which made the one place with text in it the blurriest in the game.
  engine.setFocusScale(0.08)
  atHatch = false
  hud.hint('The command deck · look at a repo to select it · N next needing you · E to leave')
}

/** Held keys → a direction in the camera's frame, written straight onto the agent. */
function driveInput() {
  const agent = colony.astronauts.driven
  if (!agent) {
    if (walkingId) stopWalk()
    return
  }

  const forward = (held.has('w') || held.has('arrowup') ? 1 : 0) - (held.has('s') || held.has('arrowdown') ? 1 : 0)
  const strafe = (held.has('d') || held.has('arrowright') ? 1 : 0) - (held.has('a') || held.has('arrowleft') ? 1 : 0)

  // The camera sits at `azimuth` from its target, so away-from-camera is the negation of
  // that heading, and screen-right is it turned a quarter turn.
  const az = rig.azimuth
  agent.input.x = -Math.sin(az) * forward + Math.cos(az) * strafe
  agent.input.z = -Math.cos(az) * forward - Math.sin(az) * strafe
  agent.input.run = held.has('shift')
  agent.input.thrust = held.has(' ')

  // Aimed at the chest rather than the boots, so the astronaut sits in the middle of the
  // frame with the colony around it instead of at the bottom edge looking at the floor.
  // Aimed higher indoors than out. The camera orbits whatever it is aimed at, so the aim
  // point is also the pivot you tip around — keeping it at chest height would mean the
  // camera had to drop to the floor to look up at all, and the top row is nearly six units
  // above that floor.
  // And lower still when the body is lying flat: the chest of a flying astronaut is near
  // its feet, and a camera aimed where the chest used to be is aimed at empty air.
  const lift = (colony.aboard ? 1.75 : 0.9) * (1 - 0.55 * Math.sin(agent.pitch))
  walkAim.set(agent.pos.x, agent.pos.y + lift, agent.pos.z)
  rig.follow(walkAim)
}

const walkAim = new THREE.Vector3()

// ── pointer ───────────────────────────────────────────────────────────────────────────

/**
 * Where an astronaut is on screen, in CSS pixels, or null if it is behind the camera.
 *
 * Measured off the engine's own viewport rather than the canvas's bounding rect: this runs
 * every frame for the selected agent, and a layout read per frame to learn a number that
 * only changes on resize is the kind of thing that quietly costs a HUD its smoothness.
 */
const cardAnchor = new THREE.Vector3()
function screenOf(agent) {
  cardAnchor.set(agent.pos.x, agent.pos.y + 0.95, agent.pos.z).project(engine.camera)
  if (cardAnchor.z > 1) return null
  const { w, h } = engine.viewport
  return { x: (cardAnchor.x * 0.5 + 0.5) * w, y: (-cardAnchor.y * 0.5 + 0.5) * h }
}

function ndc(e) {
  const rect = engine.canvas.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    aspect: rect.width / rect.height,
  }
}

engine.canvas.addEventListener('pointermove', (e) => {
  // Mid-drag the cursor is the grab hand and nothing else: running a pick every move event
  // while the world is being dragged would flicker the hover ring across the whole colony.
  if (rig.interacting) {
    engine.canvas.style.cursor = rig._mode === 'orbit' ? 'move' : 'grabbing'
    return
  }
  const p = ndc(e)
  const agent = colony.pick(p.x, p.y, p.aspect)
  hoverId = agent?.id ?? null
  colony.astronauts.setHover(agent)
  // Pointing at a quiet plot is what makes its name appear.
  const plot = plotUnder(e, p)
  colony.setHoveredPlot(plot)
  engine.canvas.style.cursor = agent || plot ? 'pointer' : 'grab'
})

/**
 * The zone under the cursor: its name plate first, then the deck itself. The plate is
 * hit-tested whether or not it is currently faded in — pointing at where a quiet project's
 * name would be is exactly what makes it appear.
 */
function plotUnder(e, p) {
  const label = colony.pickLabel(p.x, p.y)
  if (label) return label
  const ground = rig.groundPoint(e.clientX, e.clientY, hoverGround)
  return ground ? colony.plotAt(ground.x, ground.z) : null
}

// Pressing on an astronaut used to suppress the camera, on the theory that grabbing one
// should not also drag the world out from under it. But nothing is draggable *about* an
// astronaut — a press is only ever the start of a selection or the start of a pan — so all
// that suppression did was make the ground refuse to move whenever a drag happened to begin
// on top of somebody. Selection is decided on release instead, where `wasClick` already
// distinguishes a click from a drag.
engine.canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !rig.wasClick) return
  const p = ndc(e)
  const agent = colony.pick(p.x, p.y, p.aspect)
  if (agent) {
    select(agent.id, {})
    return
  }
  // Nobody there: a zone's deck or its name plate opens that repo's sidebar instead, and
  // bare ground puts everything down.
  const plot = plotUnder(e, p)
  if (plot) selectProject(plot.name, {})
  else {
    select(null, {})
    actions.closeProject()
  }
})

engine.canvas.addEventListener('pointerleave', () => {
  hoverId = null
  colony.astronauts.setHover(null)
  colony.setHoveredPlot(null)
})

// ── keyboard ──────────────────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  // Never steal keys from a field the user is actually typing in.
  const t = e.target
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return

  // ⌘\ (⌃\ elsewhere) dismisses the chrome, the same as H — the shortcut every editor
  // uses for its sidebar, and the one hand that is already on the keyboard.
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
    e.preventDefault()
    hud.toggleUi()
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return

  // Walking, the movement keys are the movement keys. `S` is the settings panel on the map
  // and "back" on the deck, and there is no reading of that which lets both have it.
  const key = e.key.toLowerCase()
  if (walkingId && key === 'e') {
    e.preventDefault()
    toggleAboard()
    return
  }

  // Aboard, the keys that act on a thread act on the one you are looking at. They fall
  // through to the map's handlers otherwise, which would act on the astronaut you are
  // wearing — not wrong exactly, but never what you meant while facing a wall of repos.
  if (colony.aboard) {
    if (key === 'n') {
      e.preventDefault()
      turnToNextUrgent()
      return
    }
    if (key === 'x') {
      e.preventDefault()
      armOrRunSweep()
      return
    }
    if (key === 'u') {
      e.preventDefault()
      undoSweep()
      return
    }
    if (key === 'f') {
      e.preventDefault()
      if (selectedProject) actions.revealProject()
      else hud.hint('Look at a repo first')
      return
    }
    if (key === '[' || key === ']') {
      e.preventDefault()
      moveDeckPick(key === '[' ? -1 : 1)
      return
    }
    if (e.key === 'Enter' || key === 'a') {
      const thread = facingThread()
      if (!thread) {
        hud.hint('Look at a repo first')
        return
      }
      e.preventDefault()
      if (e.key === 'Enter') actions.openThread(thread)
      else actions.archiveThread(thread)
      return
    }
  }

  if (walkingId && WALK_KEYS.has(key)) {
    e.preventDefault()
    // Space taps a hop and, held, keeps the jetpack lit — so it is held like the rest.
    if (key === ' ') colony.astronauts.hop(walkingId)
    held.add(key)
    return
  }

  switch (e.key) {
    case 'h':
    case 'H':
      hud.toggleUi()
      break
    case 's':
    case 'S':
      hud.toggleSettings()
      break
    case 'n':
    case 'N':
      actions.focusStatus('waiting')
      break
    case 'p':
    case 'P':
      actions.screenshot()
      break
    case 'l':
    case 'L':
      actions.cycleTime()
      break
    case 'o':
    case 'O':
      hud.setOrbit(actions.toggleOrbit())
      break
    case 'Tab':
      e.preventDefault()
      actions.cyclePlanet()
      break
    case '0':
      actions.resetView()
      hud.setOrbit(false)
      break
    case 'Enter':
      if (selectedId) actions.openThread()
      break
    case 'a':
    case 'A':
      if (selectedId) actions.archiveThread()
      break
    case 'c':
    case 'C':
      if (selectedProject) actions.newConversation()
      break
    case 'g':
    case 'G':
      actions.toggleWalk()
      break
    case 'r':
    case 'R':
      if (selectedId) hud.toggleAsk()
      break
    case '?':
      hud.toggleHelp()
      break
    // Arrow keys nudge the view and +/- zoom, the same as Earth's keyboard.
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      e.preventDefault()
      const step = rig.distance * 0.09
      const forward = new THREE.Vector3(Math.sin(rig.azimuth), 0, Math.cos(rig.azimuth))
      const right = new THREE.Vector3(forward.z, 0, -forward.x)
      if (e.key === 'ArrowUp') rig.desiredTarget.addScaledVector(forward, -step)
      if (e.key === 'ArrowDown') rig.desiredTarget.addScaledVector(forward, step)
      if (e.key === 'ArrowLeft') rig.desiredTarget.addScaledVector(right, -step)
      if (e.key === 'ArrowRight') rig.desiredTarget.addScaledVector(right, step)
      rig._clampTarget()
      rig.idleFor = 0
      break
    }
    case '+':
    case '=':
      rig.desiredDistance = Math.max(4, rig.desiredDistance * 0.82)
      break
    case '-':
    case '_':
      rig.desiredDistance = Math.min(150, rig.desiredDistance * 1.22)
      break
    // One step at a time, outward: the thread, then the zone it belongs to.
    case 'Escape':
      if (document.querySelector('.help.open')) hud.toggleHelp(false)
      else if (walkingId) stopWalk()
      else if (selectedId) select(null, {})
      else if (selectedProject) actions.closeProject()
      break
  }
})

window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()))
// Tabbing away with W down would otherwise come back to an astronaut walking into a wall
// on its own, with nothing on the keyboard able to stop it.
window.addEventListener('blur', () => held.clear())

// ── data ──────────────────────────────────────────────────────────────────────────────

function applyThreads(list) {
  threads = list
  const archivedSet = new Set(state.archived)
  const stats = colony.setThreads(list, archivedSet)
  hud.setStats(stats)

  legendProjects = colony.plotOrder
    .map((plot) => ({
      name: plot.name,
      accent: plot.accent,
      count: list.filter((t) => !t.archived && !archivedSet.has(t.id) && t.project === plot.name).length,
      urgent: colony.urgentPlots?.has(plot.id) ?? false,
    }))
    .sort((a, b) => b.count - a.count)

  // Keep the card honest if the thread it is showing changed underneath it.
  if (selectedId) {
    const still = colony.agentFor(selectedId)
    if (still) hud.setSelection(still, list.find((t) => t.id === selectedId) || still.thread)
    else select(null, {})
  }
  // Which also repaints the legend, so the open zone's chip is lit by the same pass.
  syncProject()

  // Zones only move when their own footprint changes, and when one does the colony file
  // learns about it — so the map you built up a memory of survives a reload.
  const layout = colony.layoutForSave()
  const signature = JSON.stringify(layout)
  if (signature !== lastLayout) {
    lastLayout = signature
    state.plots = layout
    queueSave()
  }
}

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    const res = await fetchThreads()
    applyThreads(res.threads || [])
    hud.removeBoot()
  } catch (err) {
    hud.toast(err.message || 'Could not reach the thread scanner', 'err')
    hud.removeBoot()
  } finally {
    polling = false
  }
}

function queueSave() {
  clearTimeout(pendingSave)
  pendingSave = setTimeout(async () => {
    try {
      await saveState(state)
    } catch {
      /* the colony still runs; only the archive list is at risk, and it retries next time */
    }
  }, 500)
}

async function boot() {
  // The model kit and the crew rig both have to be in hand before the first roster arrives:
  // buildings and the ground scatter are assembled out of the kit synchronously the moment
  // a thread shows up, and the crew's body mesh is built from the rig. Fetched alongside
  // the saved state rather than after it, since none of them waits on the others.
  const settle = (p) => p.then(() => null, (err) => err)
  const [, kitError, crewError] = await Promise.all([
    fetchState()
      .then((s) => {
        state = s
        // Before the first roster: zones come back to the ground they were on last time.
        colony.restoreLayout(state.plots)
        // And the settings, but only for a browser that has none of its own — an explicit
        // choice made here always outranks the file.
        if (!hasStoredSettings() && state.settings) settings.applyAll(state.settings)
      })
      .catch(() => {
        /* first run, or the file is gone — an empty colony state is a valid one */
      }),
    settle(loadKit()),
    settle(loadCrew()),
  ])
  if (kitError || crewError) {
    hud.toast('Could not load the model assets — run `npm run assets`', 'err')
    console.error(kitError || crewError)
  }
  colony.astronauts.setRig(crewRig())
  if (!kitError) colony.onAssetsReady()

  await poll()
  setInterval(poll, POLL_MS)
  window.addEventListener('focus', poll)
  // A tab that was hidden for an hour should catch up the moment it comes back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll()
  })

  if (!localStorage.getItem('botcrossing.seen-help')) {
    hud.toggleHelp(true)
    localStorage.setItem('botcrossing.seen-help', '1')
  } else {
    hud.hint('Drag to move · click an astronaut · H hides everything', 5200)
  }
}

// ── settings plumbing ─────────────────────────────────────────────────────────────────

settings.onChange((changed, scope) => {
  // Kept in the colony file as well as in this browser's own storage. `localStorage` is
  // per *origin*, so a dev server that comes back on a different port looks to the browser
  // like a different site and hands you factory settings — the file does not care.
  state.settings = { ...settings.values }
  queueSave()
  if (scope.render || changed.has('fov')) engine.applySettings()
  colony.onSettingsChanged(changed, scope)
  if (changed.has('showFps')) hud.syncSettings()
  if (changed.has('maxAgents')) applyThreads(threads)
})

// ── frame ─────────────────────────────────────────────────────────────────────────────

engine.add({
  update(dt, elapsed) {
    if (walkingId) driveInput()
    updateHatchPrompt()
    updateDeckFacing()
    rig.update(dt)
    colony.update(dt, elapsed, rig.target)
    // Whatever the camera is orbiting is what should be in focus.
    engine.setFocusDistance(rig.distance)

    if (selectedId) {
      hud.updateAvatar(colony.astronauts.faceTexture.image)
      // A selected astronaut that walked off the roster should not keep a stale card open.
      const agent = colony.agentFor(selectedId)
      if (!agent) select(null, {})
      else hud.placeCard(screenOf(agent))
    }
    hud.setFps(engine.perf, engine.viewport, `${colony.astronauts.visibleCount} crew · ${colony.particles.liveCount} bits`)
  },
})

engine.start()
boot()

// Handy for poking at the running colony from the console.
window.botCrossing = { engine, rig, colony, settings, hud, poll, get threads() { return threads } }

/** `execCommand('copy')` over a throwaway textarea — the copy that predates permissions. */
function copyFallback(text) {
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.cssText = 'position:fixed;top:0;opacity:0;pointer-events:none'
  document.body.appendChild(el)
  el.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  el.remove()
  return ok
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
