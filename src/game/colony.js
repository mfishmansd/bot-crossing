import * as THREE from 'three'
import { PLANETS, createTerrain, createScatter, terrainHeight, setColonyFlatRadius } from '../world/planet.js'
import { CommandDeck } from '../world/commandDeck.js'
import { Sky } from '../world/sky.js'
import {
  Plot,
  allocateCells,
  shipPosition,
  createLabel,
  hashString,
  worldToHex,
  DECK_TOP,
  PLOT_PALETTE,
  PLOT_CELL,
} from '../world/plots.js'
import { createBuilding, buildingUniforms, Scaffolds } from '../world/buildings.js'
import { Ship } from '../world/ship.js'
import { Astronauts } from '../agents/astronauts.js'
import { Indicators, BADGE } from '../agents/indicators.js'
import { Particles } from '../agents/particles.js'
import { Navigation } from '../agents/navigation.js'

/**
 * The colony: everything that turns a list of agent threads into a place.
 *
 * The mapping is the whole game. It is a strict precedence rather than a set of independent
 * flags — errored, then running, then merged, then unread — so an astronaut can only ever be
 * telling you one thing, and the loudest true thing wins.
 *
 *   errored        → blocked, red eyes, a `!` over its head
 *   running        → hammering away at its building, sparks flying
 *   PR merged      → celebrating, confetti, a `✓`
 *   unread         → stopped and waiting on you, a bobbing `?` — click it to open the thread
 *   long idle      → asleep on the job
 *   anything else  → pottering about its plot
 *
 * Threads group by repo, one repo per hex plot, and every thread gets a building seeded
 * from its own session id — so the colony's skyline is a stable, readable picture of what
 * you have running.
 */

const STALE_MS = 3 * 24 * 60 * 60 * 1000
/** How wide an astronaut is, for the purpose of not fitting through gaps it should not. */
const AGENT_RADIUS = 0.26
/**
 * The same width, for the astronaut you are steering — deliberately much smaller.
 *
 * The crew is given room so a hundred of them routing past each other never look like they
 * are scraping the walls. You are one astronaut, watched closely, and being stopped a
 * third of a metre short of a doorway you can plainly see through is the single thing that
 * makes a character feel like a physics object. Squeezing through is your problem to judge,
 * not the grid's to forbid.
 */
const DRIVEN_RADIUS = 0.08
/**
 * How much of a building actually stops you, against how much stops the crew. The bounding
 * radius over-covers anything that is not round, and the gaps between a ring of buildings
 * are precisely where a person tries to walk.
 */
const DRIVEN_FOOTPRINT = 0.66
/** Progress a live thread adds per second, so a working site visibly grows while you watch. */
const LIVE_GROWTH = 0.004
/** How many zones' positions to remember, including repos with nothing running in them. */
const LAYOUT_MEMORY = 80

/** How high up the board sits, for measuring its distance to the camera. */
const SIGN_EYE = 2.8
/** Readable all the way in to `near`, gone by `far` — where two lines of small text stop being words. */
const SIGN_FADE = { near: 46, far: 82 }
/**
 * How many signs may exist at once, and how far out one is kept before it is taken down.
 *
 * These are not tuning knobs, they are the reason the feature is affordable. Every sign owns
 * a canvas texture of its own — the text is different on each, so there is nothing to share
 * — and a projects directory can easily hold two hundred repos. Building one per zone would
 * be three hundred megabytes of texture for a colony where all but a handful are, at the
 * distance you are looking from, a grey smudge. So a sign is raised when its zone comes near
 * and disposed when it leaves, nearest first, and the budget is what the eye can read at once.
 */
const MAX_SIGNS = 26
const SIGN_KEEP = SIGN_FADE.far + 22
/** How often the sweep runs. Signs appear as you approach, and half a second is not a wait. */
const SIGN_SWEEP = 0.5
/**
 * How far apart two boards have to stand. A board turns to face the camera, so it sweeps a
 * disc of its own width as you orbit; below about twice that, two of them intersect.
 */
const SIGN_APART = 5.6
/**
 * How far a board may turn off the direction its plot faces.
 *
 * It turns to the camera so it can be read, but not all the way round: past about this much
 * it would be swinging back over its own plot, where the buildings are, and a board is wide
 * enough to reach one. Stopping here also happens to be what a real sign does — walk behind
 * it and you get the back of it, not a board that follows you.
 */
const SIGN_SWING = THREE.MathUtils.degToRad(74)

export const STATUS_ORDER = ['blocked', 'waiting', 'working', 'celebrating', 'idle', 'sleeping']

export const STATUS_LABEL = {
  working: 'Working',
  waiting: 'Waiting on you',
  blocked: 'Blocked',
  celebrating: 'Shipped',
  idle: 'Idle',
  sleeping: 'Dormant',
  spawning: 'Arriving',
  leaving: 'Heading home',
}

/** Thread → behaviour. First match wins, exactly like the board's auto-sort. */
export function statusFor(thread, now = Date.now()) {
  if (thread.hasError) return 'blocked'
  if (thread.running) return 'working'
  if (thread.prState === 'MERGED') return 'celebrating'
  if (thread.unread) return 'waiting'
  if (now - thread.lastActivityAt > STALE_MS) return 'sleeping'
  return 'idle'
}

/**
 * Which behaviours earn a badge. Dormant and idle deliberately get none: their pose and
 * face already say it, and with most of a real thread list sitting quiet, a badge over
 * every one of them buries the single `?` that actually wants you.
 */
const BADGE_FOR = {
  waiting: BADGE.waiting,
  blocked: BADGE.blocked,
  working: BADGE.working,
  celebrating: BADGE.done,
  sleeping: BADGE.none,
  idle: BADGE.none,
  spawning: BADGE.spawning,
  leaving: BADGE.leaving,
}

/** Transcript size → how finished the building looks. Log scale: threads grow fast early. */
/**
 * How far along a thread is, on a log scale over its transcript size. This drives the bar
 * on the thread card — it no longer drives how much of the building you can see.
 *
 * It used to. The shader draws construction by sinking the structure into the ground and
 * discarding what falls below the deck, and mapping transcript size onto that meant most
 * buildings stood permanently waist-deep in their own plot. Read as a picture of a colony
 * rather than as a chart, that is not "this thread is young", it is "this building is
 * broken" — a dome cut off by a flat plane looks like a rendering fault, and it is the
 * first thing the eye goes to. So the sink is now only what it is good at: the few seconds
 * of a new building rising out of the ground.
 */
export function transcriptProgress(thread) {
  const size = Math.max(1, thread.sizeBytes || 0)
  return THREE.MathUtils.clamp((Math.log10(size) - 3) / 3.5, 0.05, 1)
}

export class Colony {
  constructor(scene, settings, camera, renderer) {
    this.scene = scene
    this.settings = settings
    this.camera = camera
    this.renderer = renderer

    this.planet = PLANETS[settings.get('planet')] || PLANETS.moon
    this.sky = new Sky(scene, settings, renderer)
    this.sky.setPlanet(this.planet)
    // Push the stored time in explicitly. `settings.set` is a no-op when the value has not
    // changed, so a colony restored at dusk would otherwise open in the morning and stay
    // there until something happened to touch the slider.
    this.sky.setTime(settings.get('timeOfDay'))

    this.plots = new Map()
    this.plotOrder = []
    /**
     * Where every zone sits, kept across polls *and* across the departures of the threads
     * that made it: a repo whose last session you archive comes back to the same ground
     * when a new one starts. Seeded from the colony file by `restoreLayout`.
     */
    this.plotCells = new Map()
    this.buildings = new Map()
    this.threads = new Map()
    this.usedAccents = new Set()

    this.worldGroup = new THREE.Group()
    this.worldGroup.name = 'world'
    scene.add(this.worldGroup)

    this.ship = new Ship(scene, shipPosition())
    // The room behind the hatch. Built once and left dark; see `commandDeck.js` for why it
    // is not inside the ship it belongs to.
    this.deck = new CommandDeck(scene)
    this.aboard = false
    /** Which row of the facing repo's queue is picked. The page moves it; the console draws it. */
    this.deckCursor = 0
    /** When you last left the deck, or 0. Anything that moved since is marked on the wall. */
    this.deckSince = 0
    this.astronauts = new Astronauts(scene, settings)
    this.astronauts.world = this._world()
    this.indicators = new Indicators(scene, settings, Math.max(64, settings.get('maxAgents')))
    this.particles = new Particles(scene, settings)
    this.scaffolds = new Scaffolds(scene, 320)
    this.nav = new Navigation()
    this.astronauts.setNavigation(this.nav)

    this.plotGroup = new THREE.Group()
    this.labelGroup = new THREE.Group()
    scene.add(this.plotGroup, this.labelGroup)

    // Dismissing the HUD has to survive a poll: labels are chrome, and a scan landing while
    // everything is hidden must not quietly put them back on screen.
    this.uiVisible = true
    this.hoveredPlot = null
    this.activePlots = new Set()
    /** What each repo's README says it is, by project name. Kept across plot rebuilds. */
    this.readmes = new Map()
    this._dustTint = new THREE.Color(this.planet.ground.high)
    this._c = new THREE.Color()
    this.stats = { agents: 0, projects: 0, working: 0, waiting: 0, blocked: 0, done: 0 }

    this._buildTerrain()
  }

  // ── terrain ─────────────────────────────────────────────────────────────────────────

  _buildTerrain() {
    if (this.terrain) {
      this.worldGroup.remove(this.terrain)
      this.terrain.geometry.dispose()
      this.terrain.material.dispose()
    }
    if (this.scatterGroup) {
      this.worldGroup.remove(this.scatterGroup)
      disposeTree(this.scatterGroup)
    }

    this.terrain = createTerrain(this.planet, this.settings.get('groundDetail'))
    this.worldGroup.add(this.terrain)
    this._buildScatter()

    // The ship has legs, and legs have to reach the ground. Its landing spot is a fixed hex
    // cell, but the height of that spot is the planet's, so it is set here rather than once
    // at construction — a world with more relief would otherwise leave it hovering.
    const ship = shipPosition()
    this.ship.group.position.y = terrainHeight(ship.x, ship.z, this.planet)

    this._dustTint.set(this.planet.ground.high)
  }

  /**
   * Ground scatter, placed to miss every tile of every plot and the ship's apron.
   *
   * Kept separate from the terrain because of *when* it has to run: the world is built
   * before the first roster arrives, so at that point there are no plots to avoid, and
   * boulders and trees end up under decks that are laid on top of them afterwards — poking
   * through in fragments. So this runs again whenever a zone's footprint changes, which is
   * cheap next to rebuilding the terrain mesh alongside it.
   */
  _buildScatter() {
    if (this.scatterGroup) {
      this.worldGroup.remove(this.scatterGroup)
      disposeTree(this.scatterGroup)
    }
    const clear = []
    for (const plot of this.plotOrder) {
      for (const local of plot.localCenters) {
        clear.push({ x: plot.center.x + local.x, z: plot.center.z + local.z, r: 8.6 })
      }
    }
    const ship = shipPosition()
    clear.push({ x: ship.x, z: ship.z, r: 7.5 })
    this.scatterGroup = createScatter(this.planet, this.settings.get('scatterDensity'), clear)
    this.worldGroup.add(this.scatterGroup)
    this._scatterFootprint = this._plotFootprint()
    // The crew routes around scatter, so a new scatter is a new navigation grid.
    if (this.nav) this._rebuildNavigation()
  }

  /** What the scatter has to avoid, as one string — cheap to compare every poll. */
  _plotFootprint() {
    return this.plotOrder.map((plot) => plot.signature).join('|')
  }

  /**
   * Called once the model kits are in.
   *
   * The colony is built before boot has finished fetching them, so the first terrain is
   * scattered with fallback primitives. Rebuilding it here is what puts the real trees and
   * boulders down — without it the ground keeps its placeholders until something else
   * happens to invalidate the terrain, which on a colony nobody touches is never.
   */
  onAssetsReady() {
    this._buildTerrain()
  }

  setPlanet(id) {
    const planet = PLANETS[id]
    if (!planet || planet === this.planet) return
    this.planet = planet
    this.sky.setPlanet(planet)
    this._buildTerrain()
  }

  onSettingsChanged(changed, scope) {
    if (changed.has('planet')) this.setPlanet(this.settings.get('planet'))
    else if (scope.world) this._buildTerrain()

    this.sky.onSettingsChanged(changed)
    this.astronauts.onSettingsChanged(changed)
    this.particles.onSettingsChanged(changed)
    if (changed.has('showLabels')) this._syncLabels()
    if (changed.has('timeOfDay')) this.sky.setTime(this.settings.get('timeOfDay'))
  }

  // ── roster ──────────────────────────────────────────────────────────────────────────

  /**
   * Take a fresh scan and reshape the colony around it. Everything here is keyed by stable
   * ids — repo name for plots, session id for buildings — so a poll that changes nothing
   * moves nothing on screen.
   */
  setThreads(threads, archivedIds = new Set()) {
    const now = Date.now()
    const live = threads.filter((t) => !t.archived && !archivedIds.has(t.id))

    // Group by repo, biggest project first so the busiest work lands nearest the middle.
    const byProject = new Map()
    for (const thread of live) {
      const key = thread.project || 'unknown'
      if (!byProject.has(key)) byProject.set(key, [])
      byProject.get(key).push(thread)
    }
    const projects = [...byProject.entries()].sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length
      return a[0].localeCompare(b[0])
    })

    this._syncPlots(projects)

    const roster = []
    const seenBuildings = new Set()
    const stats = { agents: 0, projects: projects.length }
    for (const key of STATUS_ORDER) stats[key] = 0
    // Plots holding anything that wants your attention get a pulsing rim, so you can spot
    // the repo that needs you from right across the colony without reading a single label.
    const urgent = new Set()
    // Plots with anyone working, waiting or stuck keep their name on screen; quiet ones
    // only show it on hover.
    const active = new Set()

    for (const [name, list] of projects) {
      const plot = this.plots.get(name)
      if (!plot) continue
      // Oldest thread first, so a given session keeps its slot as siblings come and go.
      list.sort((a, b) => a.createdAt - b.createdAt)

      list.forEach((thread, i) => {
        const status = statusFor(thread, now)
        if (stats[status] !== undefined) stats[status]++
        if (status === 'waiting' || status === 'blocked') urgent.add(plot.id)
        if (status === 'waiting' || status === 'blocked' || status === 'working') active.add(plot.id)
        stats.agents++

        const building = this._syncBuilding(thread, plot, i)
        seenBuildings.add(thread.id)

        roster.push({
          id: thread.id,
          thread,
          status,
          site: this._workSite(plot, building, i),
          // Where the work actually is. A working astronaut circles it rather than standing
          // at one spot, so it needs the building, not just a place to stand near it.
          anchor: building.mesh.position.clone(),
        })
      })
    }

    // Anything that dropped out of the scan — archived, or a transcript that vanished —
    // takes its building down and walks its astronaut back to the ship.
    for (const [id, entry] of this.buildings) {
      if (!seenBuildings.has(id)) this._removeBuilding(id, entry)
    }

    this.threads = new Map(live.map((t) => [t.id, t]))
    this.urgentPlots = urgent
    this.activePlots = active
    this._rebuildNavigation()
    this.stats = { ...stats, done: stats.celebrating }
    // Who gets an astronaut, when there are more threads than the crew slider allows: the
    // ones that need you first. The roster is built busiest repo first and oldest thread
    // first within it, and until now the cap simply took the top of that — so a colony
    // where two thirds of the threads are asleep put eighty sleepers on the surface and left
    // most of the sixty that wanted an answer without a body. The sort is stable and every
    // entry's slot was fixed above before it happens, so nobody moves house; a thread that
    // wakes up gains an astronaut, and one that nods off may lose its turn, which is what
    // the surface is for.
    roster.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
    this.astronauts.setRoster(roster, this._world())
    return this.stats
  }

  _syncPlots(projects) {
    // The previous layout is an input, so a zone only moves when its own footprint changes
    // — never because a different repo gained or lost a thread. `plotCells` carries it
    // between polls, and the colony file carries it between sessions.
    const layout = allocateCells(
      projects.map(([name, list]) => ({ id: name, size: list.length })),
      this.plotCells
    )
    // Remembered, not replaced: a project that has just lost its last thread keeps its
    // ground on the books, and the oldest entries fall off the end.
    for (const [name, cells] of layout) {
      this.plotCells.delete(name)
      this.plotCells.set(name, cells)
    }
    while (this.plotCells.size > LAYOUT_MEMORY) this.plotCells.delete(this.plotCells.keys().next().value)

    const wanted = new Map()
    for (const [name, cells] of layout) wanted.set(name, `${name}:${cells.map((c) => `${c.q},${c.r}`).join('/')}`)

    // A plot is rebuilt whenever its own footprint moved, and left completely alone
    // whenever it did not.
    for (const [name, plot] of this.plots) {
      if (wanted.get(name) === plot.signature) continue
      this.plotGroup.remove(plot.group)
      if (plot.label) {
        this.labelGroup.remove(plot.label)
        plot.label.userData.dispose?.()
      }
      this.usedAccents.delete(plot.accent)
      plot.dispose()
      this.plots.delete(name)
    }

    // Every cell the whole colony holds, so a new plot can pick a corner for its sign that
    // does not point straight at the neighbour's.
    const occupied = new Set()
    for (const cells of layout.values()) {
      for (const cell of cells) occupied.add(`${cell.q},${cell.r}`)
    }

    projects.forEach(([name], index) => {
      if (this.plots.has(name)) return
      const cells = layout.get(name)
      if (!cells?.length) return
      const accent = this._pickAccent(name)
      const plot = new Plot({ id: name, name, index, cells, accent, occupied })
      plot.signature = wanted.get(name)
      this.plots.set(name, plot)
      this.plotGroup.add(plot.group)

      const label = createLabel(name, accent)
      label.position.set(plot.labelAnchor.x, 3.2, plot.labelAnchor.z)
      plot.label = label
      this.labelGroup.add(label)
      label.material.depthTest = this._labelsInWorld === true

      // Where its sign would stand, whether or not it ever gets one: the sweep needs the
      // distance from the camera to a board that does not exist yet in order to decide
      // whether to build it.
      plot.signWorld = new THREE.Vector3(
        plot.center.x + plot.signSpot.x,
        DECK_TOP + SIGN_EYE,
        plot.center.z + plot.signSpot.z
      )
    })

    this.plotOrder = [...this.plots.values()]
    // Zones that just moved, appeared or grew are zones the scatter does not know about.
    if (this.scatterGroup && this._plotFootprint() !== this._scatterFootprint) this._buildScatter()
    // Which hex cells are decked. Ground height is asked for once per moving agent per
    // frame, so it wants to be a lookup rather than a scan over every plot's every tile.
    this.deckedCells = new Set()
    for (const plot of this.plotOrder) {
      for (const cell of plot.cells) this.deckedCells.add(`${cell.q},${cell.r}`)
    }
    this._syncLabels()
  }

  /**
   * How high the ground is at a world point — the surface anything walking stands on.
   *
   * A plot's tiles are a raised slab, so on one of those it is the deck; everywhere else it
   * is the terrain, sampled from the same noise field the mesh was built from. Without this
   * the crew walks along y=0 while the ground around them runs from -0.35 to +0.20, and they
   * spend half the colony buried to the shins.
   */
  /** The bits of the world the crew needs to know about, as plain callbacks. */
  _world() {
    return {
      shipDoor: () => this.ship.shipDoor(),
      groundAt: (x, z) => this.groundAt(x, z),
    }
  }

  groundAt(x, z) {
    const cell = worldToHex(x, z)
    if (this.deckedCells?.has(`${cell.q},${cell.r}`)) return DECK_TOP
    return terrainHeight(x, z, this.planet)
  }

  /** A stable colour per repo, probing forward on a collision so no two plots match. */
  _pickAccent(name) {
    const start = hashString(name) % PLOT_PALETTE.length
    for (let i = 0; i < PLOT_PALETTE.length; i++) {
      const accent = PLOT_PALETTE[(start + i) % PLOT_PALETTE.length]
      if (!this.usedAccents.has(accent)) {
        this.usedAccents.add(accent)
        return accent
      }
    }
    return PLOT_PALETTE[start]
  }

  _syncBuilding(thread, plot, index) {
    let entry = this.buildings.get(thread.id)
    // Whole, always. A building that has finished rising is a building you can see all of.
    const target = 1

    if (!entry) {
      const mesh = createBuilding({ seed: hashString(thread.id), accent: plot.accent })
      const pos = plot.worldSlot(index)
      mesh.position.copy(pos)
      mesh.rotation.y = ((hashString(thread.id) >>> 8) % 360) * (Math.PI / 180)
      // New buildings rise from nothing rather than appearing whole.
      mesh.userData.setProgress(0)
      this.worldGroup.add(mesh)
      entry = { mesh, plot: plot.id, slot: index, progress: 0, target, retiring: false }
      this.buildings.set(thread.id, entry)
    } else {
      // Where this building belongs *now*. Comparing the world position rather than the
      // plot id and slot number is what catches a zone that was rebuilt underneath it: the
      // repo is the same and the slot is the same, but the ground moved, and a habitat left
      // behind on bare terrain takes its astronaut off the plot with it.
      const want = plot.worldSlot(index, this._slotAt || (this._slotAt = new THREE.Vector3()))
      if (entry.plot !== plot.id || entry.slot !== index || entry.mesh.position.distanceToSquared(want) > 1e-4) {
        entry.plot = plot.id
        entry.slot = index
        entry.mesh.position.copy(want)
      }
    }

    entry.target = target
    entry.accent = plot.accent
    entry.retiring = false
    return entry
  }

  _removeBuilding(id, entry) {
    // Wind the reveal back down, then take it out — a building that vanishes mid-frame
    // reads as a glitch, one that sinks reads as being packed up.
    entry.retiring = true
    entry.target = 0
    if (entry.progress <= 0.02) {
      this.worldGroup.remove(entry.mesh)
      entry.mesh.geometry.dispose()
      entry.mesh.material.dispose()
      entry.mesh.customDepthMaterial?.dispose()
      this.buildings.delete(id)
    }
  }

  /**
   * Hand the navigation grid the colony's current footprint.
   *
   * The blocking radius is the building's bounding radius trimmed a little, plus the
   * astronaut's own width. The trim matters: the bounding radius already over-covers
   * anything that is not round, and blocking the full extent closes the gaps between a ring
   * of buildings, which is exactly where the crew needs to walk.
   *
   * Every obstacle gets an `r`, which is what stops the crew. Only the ones you could not
   * plausibly walk over or squeeze past — buildings, the ship — also get an `rSolid`, the
   * tighter radius that stops the astronaut you are steering.
   */
  _rebuildNavigation() {
    // The grid has to cover the colony before anything is rasterised into it. A zone the
    // grid does not reach is a zone whose every cell reads as blocked, and an astronaut that
    // walked out to one spends the rest of the session shouldering an invisible wall.
    let reach = 0
    for (const plot of this.plotOrder) {
      reach = Math.max(reach, Math.abs(plot.center.x) + plot.radius, Math.abs(plot.center.z) + plot.radius)
    }
    this.nav.resize(reach + 6)

    // The ground has to be flat wherever the plots are. The hills used to ramp in from a
    // fixed forty units regardless of how far the colony had spread, so the outer zones of
    // a large one were laid into rising ground and disappeared beneath it. Same `reach` the
    // grid is sized by, so the flat middle and the walkable area can never disagree.
    // Guarded because the call graph closes a loop: rebuilding the terrain rebuilds the
    // scatter, and new scatter rebuilds this grid. Growing the radius only once would make
    // that terminate on its own, but relying on that is relying on an accident.
    if (!this._fittingGround && setColonyFlatRadius(reach + 10)) {
      this._fittingGround = true
      try {
        this._buildTerrain()
      } finally {
        this._fittingGround = false
      }
    }

    const obstacles = []
    for (const entry of this.buildings.values()) {
      if (entry.retiring) continue
      const p = entry.mesh.position
      const footprint = entry.mesh.userData.footprint || 1.2
      obstacles.push({
        x: p.x,
        z: p.z,
        r: footprint * 0.8 + AGENT_RADIUS,
        // A building is the one thing you genuinely cannot walk through, but it stops you
        // at a tighter radius than it stops the crew.
        rSolid: footprint * DRIVEN_FOOTPRINT + DRIVEN_RADIUS,
      })
    }
    // Ground clutter counts too. A crate is only knee-high, but an astronaut walking
    // straight through one is exactly as wrong as one walking through a habitat.
    for (const plot of this.plotOrder) {
      for (const spot of plot.clutterSpots || []) {
        // No `rSolid`: a crate is knee-high, and you step over it.
        obstacles.push({ x: plot.center.x + spot.x, z: plot.center.z + spot.z, r: spot.r + AGENT_RADIUS })
      }
    }
    // Ground scatter counts as well. A boulder an astronaut can walk through is the same
    // bug as a habitat it can walk through, and a sleeping one parked inside a solar panel
    // is what that bug looks like from the outside. Instances are read straight off the
    // matrices, so this costs no bookkeeping of its own.
    const mat = this._navMatrix || (this._navMatrix = new THREE.Matrix4())
    for (const mesh of this.scatterGroup?.children || []) {
      if (!mesh.isInstancedMesh || !mesh.count) continue
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      const box = mesh.geometry.boundingBox
      const spread = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, mat)
        const scale = Math.hypot(mat.elements[0], mat.elements[1], mat.elements[2])
        const r = spread * scale * 0.65
        // Only what an astronaut would visibly stand *inside*. Blocking every pebble and
        // sprig fences the corridors between zones — the crew walks the gaps between plots
        // to get anywhere, and scatter is placed in exactly those gaps.
        if (r < 0.55) continue
        // No `rSolid` either — boulders and panels are yours to walk over.
        obstacles.push({ x: mat.elements[12], z: mat.elements[14], r: r + AGENT_RADIUS })
      }
    }

    const ship = shipPosition()
    obstacles.push({ x: ship.x, z: ship.z, r: 3.4 + AGENT_RADIUS, rSolid: 3.4 + DRIVEN_RADIUS })
    this.nav.rebuild(obstacles)
  }

  /**
   * Go aboard. The wall is pointed at the colony on the way in rather than every frame:
   * what a panel shows only changes when a scan lands, and a scan is not a frame.
   */
  boardShip() {
    if (this.aboard) return null
    const agent = this.astronauts.boardInterior(this.deck.entry(), this.deck.floorY, this.deck.bounds())
    if (!agent) return null
    this.aboard = true
    this.deck.setAboard(true)
    this.syncDeck()
    this.deck.setConsole(this.consoleSummary())
    return agent
  }

  /**
   * Back out — at the foot of the ramp, where astronauts always come and go, or anywhere
   * you name. The deck is the one place that knows every repo at once, so stepping out of
   * it straight onto the one you were looking at is the shortest route across the colony
   * there is.
   */
  leaveShip(at = null) {
    if (!this.aboard) return null
    this.aboard = false
    this.deck.setConsole(null)
    this.deck.setAboard(false)
    const spot = at || this.ship.shipDoor()
    return this.astronauts.leaveInterior(spot)
  }

  /** Where you land if you step out of the ship onto a repo: the middle of its zone. */
  landingFor(project) {
    const plot = this.plots.get(project)
    if (!plot) return null
    const p = plot.middle || plot.center
    return { x: p.x, y: 0, z: p.z }
  }

  /**
   * One panel per repo, not per thread.
   *
   * A thread is the wrong unit for a wall. There are four hundred of them against two
   * hundred panels, they come and go as sessions open and close, and a panel whose meaning
   * changes underneath you is one you cannot learn the position of. A repo is stable, there
   * are fewer of them than there are panels, and it is the thing you actually think in.
   *
   * Counted off `threads` and not off the crew, which is the whole reason this is worth a
   * comment. The astronaut pool is the crew slider — ninety here — and it is filled by
   * what needs you first, so the crew you can see on the surface is a sample of the
   * colony rather than the whole of it. Rolling the wall up from astronauts showed eleven repos out
   * of a hundred and seventy-one and looked for all the world like a rendering bug. The
   * threads are the truth; the astronauts are a sample of them that happens to fit.
   */
  syncDeck() {
    if (!this.aboard) return
    const now = Date.now()
    const byProject = new Map()
    for (const thread of this.threads.values()) {
      const key = thread.project || 'unknown'
      let row = byProject.get(key)
      if (!row) {
        row = byProject.set(key, { counts: {}, total: 0, harness: '', title: '', threadId: null, rank: 99, moved: false }).get(key)
      }
      row.total++
      if (this.deckSince && thread.lastActivityAt > this.deckSince) row.moved = true
      const status = statusFor(thread, now)
      row.counts[status] = (row.counts[status] || 0) + 1
      if (!row.harness) row.harness = thread.harnessName || thread.harness || ''
      // Carry the worst thread's title: it is the one sentence saying why this repo is lit,
      // and STATUS_ORDER is already written worst first, so its index is the ranking.
      const rank = STATUS_ORDER.indexOf(status)
      if (rank >= 0 && rank < row.rank) {
        row.rank = rank
        row.title = thread.title || ''
        // And its id, because the panel is not just a label: Enter on it opens this thread.
        row.threadId = thread.id
      }
    }

    // Walked in plot order, which is the order the zones were laid out in and the order the
    // sidebar lists them: busiest first. So a repo is in the same place on the wall every
    // time you come aboard, and in the same place as everywhere else in the app.
    const rows = []
    for (const plot of this.plotOrder) {
      const row = byProject.get(plot.id)
      if (!row) continue
      rows.push({
        id: plot.id,
        project: plot.id,
        total: row.total,
        counts: row.counts,
        // The worst thing happening in a repo is what the repo's panel is coloured by.
        status: STATUS_ORDER.find((key) => row.counts[key]) || 'idle',
        title: row.title,
        threadId: row.threadId,
        harness: row.harness,
        moved: row.moved,
      })
    }
    this.deck.sync(rows)
  }

  /** Set before boarding, from the colony file, so the first sync can mark what moved. */
  setDeckSince(at) {
    this.deckSince = at || 0
  }

  /**
   * The console with nobody's repo on it: the colony's own numbers, the same ones the HUD
   * chips show. Counted off `stats`, which the roster pass fills from every thread before
   * the crew cap is applied — so these are the colony, not the sample of it on the surface.
   */
  consoleSummary() {
    const s = this.stats
    const moved = new Set()
    if (this.deckSince) {
      for (const thread of this.threads.values()) {
        if (thread.lastActivityAt > this.deckSince) moved.add(thread.project || 'unknown')
      }
    }
    return {
      summary: true,
      since: this.deckSince,
      moved: moved.size,
      threads: s.agents,
      repos: this.plotOrder.length,
      waiting: s.waiting || 0,
      working: s.working || 0,
      blocked: s.blocked || 0,
      done: s.done || 0,
    }
  }

  /**
   * Everything the console says about one repo, in one object. Assembled here because the
   * colony is the only thing that holds both halves — the readme cache, and the threads.
   * `readmes` has three states worth telling apart: never asked (undefined), asked and
   * there is none (null), and an answer.
   */
  consoleFor(name) {
    const now = Date.now()
    const summary = this.readmes.get(name)
    const threads = []
    for (const thread of this.threads.values()) {
      if ((thread.project || 'unknown') !== name) continue
      threads.push({
        id: thread.id,
        title: thread.title || '',
        status: statusFor(thread, now),
        // Its last message. Every thread carries one and nothing showed it; it is the
        // difference between a list of titles and a room of people mid-sentence.
        preview: thread.preview || '',
      })
    }
    // Worst first, exactly the order Enter works through them.
    threads.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
    return {
      project: name,
      title: summary?.title || '',
      tagline: summary?.tagline || '',
      readmeState: summary === undefined ? 'loading' : summary === null ? 'none' : 'ready',
      threads,
      // Kept on the colony rather than passed in, so the tick that refreshes the console
      // every three quarters of a second does not put the pick back to the top.
      cursor: Math.max(0, Math.min(this.deckCursor, threads.length - 1)),
    }
  }

  /**
   * Whether the zone name plates are things in the world or labels over it.
   *
   * On the map they are labels: drawn over everything, so a habitat between you and a name
   * can never cut it in half. That is the right call from forty units up and exactly the
   * wrong one from the ground, where the same rule paints "AriInvitation" across the back
   * of the helmet you are wearing. Walking, the plates go back into the world and are
   * covered by whatever is in front of them — which is what a sign is.
   */
  setLabelsInWorld(on) {
    this._labelsInWorld = on
    for (const label of this.labelGroup.children) label.material.depthTest = on
  }

  /** The plot under a world point. On a hex lattice the nearest cell centre is the cell. */
  plotAt(x, z) {
    let best = null
    let bestD = Infinity
    for (const plot of this.plotOrder) {
      for (const local of plot.localCenters) {
        const dx = x - (plot.center.x + local.x)
        const dz = z - (plot.center.z + local.z)
        const d = dx * dx + dz * dz
        if (d < bestD) {
          bestD = d
          best = plot
        }
      }
    }
    return bestD <= PLOT_CELL * PLOT_CELL ? best : null
  }

  /**
   * The plot whose name plate is under the cursor.
   *
   * Plates are billboarded in the vertex shader — a CPU raycast against the quad would test
   * the geometry as authored, which is not where it ends up on screen. So this repeats the
   * shader's own maths instead: the plate sits at its anchor in view space and spans
   * `half * (0.55 + dist * 0.03)`, which projects to `half * k * P / dist` in NDC.
   *
   * Opacity is deliberately not consulted. A quiet project's plate is invisible until it is
   * pointed at, and it is this hit test that decides it is being pointed at.
   */
  pickLabel(ndcX, ndcY) {
    const view = this._labelView || (this._labelView = new THREE.Vector3())
    const p = this.camera.projectionMatrix.elements
    let best = null
    let bestDist = Infinity
    for (const plot of this.plotOrder) {
      const label = plot.label
      if (!label) continue
      const dist = -view.copy(label.position).applyMatrix4(this.camera.matrixWorldInverse).z
      if (dist <= 0.01 || dist >= bestDist) continue
      const geo = label.geometry.parameters
      const k = 0.55 + dist * 0.03
      const cx = (view.x * p[0]) / dist
      const cy = (view.y * p[5]) / dist
      if (Math.abs(ndcX - cx) > ((geo.width / 2) * k * p[0]) / dist) continue
      if (Math.abs(ndcY - cy) > ((geo.height / 2) * k * p[5]) / dist) continue
      bestDist = dist
      best = plot
    }
    return best
  }

  /**
   * Take the zone layout out of the colony file. Cells arrive as `[q, r]` pairs from a file
   * a person can edit, so anything that is not a pair of whole numbers is dropped rather
   * than trusted — a bad entry would put a zone on a cell that does not exist.
   */
  restoreLayout(saved) {
    const clean = new Map()
    for (const [name, cells] of Object.entries(saved || {})) {
      if (!Array.isArray(cells)) continue
      const list = []
      for (const cell of cells) {
        const q = Array.isArray(cell) ? cell[0] : cell?.q
        const r = Array.isArray(cell) ? cell[1] : cell?.r
        if (Number.isInteger(q) && Number.isInteger(r)) list.push({ q, r })
      }
      if (list.length) clean.set(String(name), list)
    }
    this.plotCells = clean
  }

  /** The same, on the way out. */
  layoutForSave() {
    const out = {}
    for (const [name, cells] of this.plotCells) out[name] = cells.map((c) => [c.q, c.r])
    return out
  }

  setHoveredPlot(plot) {
    this.hoveredPlot = plot || null
  }

  /**
   * Names fade in for the plots that have something going on, and for whichever one you are
   * pointing at. Everywhere else the colony stays unlabelled.
   */
  _updateLabels(dt) {
    const show = this.uiVisible && this.settings.get('showLabels')
    for (const plot of this.plotOrder) {
      const label = plot.label
      if (!label) continue
      const wanted = show && (this.activePlots.has(plot.id) || this.hoveredPlot === plot) ? 1 : 0
      const next = THREE.MathUtils.damp(label.material.opacity, wanted, 9, dt)
      label.material.opacity = next
      label.visible = next > 0.01
    }
  }

  /**
   * What a repo's README says it is. Handed in once the page has read one, and remembered
   * by name so a zone that gets rebuilt onto new cells raises the same sign again.
   *
   * `null` takes the sign down, which is the honest answer for a folder that has no README:
   * an empty board is worse than no board.
   */
  setReadme(name, summary) {
    const next = summary && (summary.title || summary.tagline) ? summary : null
    const had = this.readmes.has(name)
    const before = this.readmes.get(name)
    // `null` is stored rather than deleted, and it means "asked, and there is no readme" —
    // which is the answer that stops the sweep asking again every half second.
    this.readmes.set(name, next)
    // The console may be waiting on exactly this answer.
    if (this.aboard && this.deck.consoleName === name) this.deck.setConsole(this.consoleFor(name))
    if (had && before?.title === next?.title && before?.tagline === next?.tagline) return
    // Down, not up: the sweep decides whether this zone is near enough to be worth a board.
    this.plots.get(name)?.clearSign()
  }

  /**
   * Signs turn to face you, and fade out once they are too far away to read.
   *
   * The turn is the whole sign about its own post rather than the board about its mounting,
   * which is why the post is a single central one — swinging a board on two legs reads as a
   * glitch, swinging the pole it is bolted to does not read at all.
   *
   * The fade is not decoration. A board carrying two lines of 13px text is illegible past
   * about seventy units and becomes a grey smudge on the horizon; taking it out there keeps
   * the wide shot clean, and is what makes the sign worth having up close.
   */
  _updateSigns(dt) {
    const show = this.uiVisible && this.settings.get('showSigns')
    const eye = this.camera.position

    this._signClock = (this._signClock || 0) + dt
    if (this._signClock >= SIGN_SWEEP) {
      this._signClock = 0
      this._sweepSigns(eye, show)
    }

    for (const plot of this.plotOrder) {
      const sign = plot.sign
      if (!sign) continue
      const board = sign.userData.board
      const dist = plot.signWorld ? plot.signWorld.distanceTo(eye) : 0
      const wanted = show ? THREE.MathUtils.smoothstep(SIGN_FADE.far - dist, 0, SIGN_FADE.far - SIGN_FADE.near) : 0
      const next = THREE.MathUtils.damp(board.material.opacity, wanted, 8, dt)
      board.material.opacity = next
      sign.visible = next > 0.01
      if (!sign.visible) continue
      // Yaw only, and only so far: the sign stays planted, and a board that pitched with the
      // camera would stop being an object in the world and start being a label again.
      const base = Math.PI / 2 - plot.signSpot.angle
      const want = Math.atan2(eye.x - plot.signWorld.x, eye.z - plot.signWorld.z)
      // Shortest way round, so the clamp is against the real angle between them rather than
      // against whichever multiple of 2π the two happened to land on.
      const swing = Math.atan2(Math.sin(want - base), Math.cos(want - base))
      sign.rotation.y = base + THREE.MathUtils.clamp(swing, -SIGN_SWING, SIGN_SWING)
    }
  }

  /**
   * Which zones get a board right now: the nearest `MAX_SIGNS` inside `SIGN_KEEP`, and no
   * others. Everything else has its sign disposed, which is the only reason a colony of two
   * hundred repos can have signs at all.
   *
   * This is also where a README is asked for. A zone nobody has been near has never had one
   * read, and reading two hundred of them at boot to paint two hundred boards you cannot see
   * is the same waste in a different currency.
   */
  _sweepSigns(eye, show) {
    const near = []
    for (const plot of this.plotOrder) {
      if (!plot.signWorld) continue
      const dist = plot.signWorld.distanceTo(eye)
      if (dist > SIGN_KEEP || !show) {
        plot.clearSign()
        continue
      }
      near.push({ dist, plot })
    }
    if (!show) return

    near.sort((a, b) => a.dist - b.dist)
    const raised = []
    for (let i = 0; i < near.length; i++) {
      const plot = near[i].plot
      // Nearest first, so when two zones want boards in the same spot the one you are
      // standing over keeps its own. Corners are already chosen to face open ground; this
      // is the backstop for a colony packed tightly enough that they cannot all be.
      const crowded =
        i >= MAX_SIGNS || raised.some((other) => other.signWorld.distanceToSquared(plot.signWorld) < SIGN_APART * SIGN_APART)
      if (crowded) {
        plot.clearSign()
        continue
      }
      if (!this.readmes.has(plot.name)) {
        this.onReadmeWanted?.(plot.name)
        continue
      }
      const summary = this.readmes.get(plot.name)
      if (summary && !plot.sign) plot.setSign(summary.title, summary.tagline)
      if (plot.sign) raised.push(plot)
    }
  }

  /** Where the astronaut stands: just outside its building, facing in. */
  _workSite(plot, entry, index) {
    const b = entry.mesh.position
    // Outward from the *middle* of the zone rather than from its root tile: the root sits
    // on one edge of a grown blob, and standing spots measured from there all point the
    // same way instead of fanning around the buildings.
    const middle = plot.middle || plot.center
    const dx = b.x - middle.x
    const dz = b.z - middle.z
    const len = Math.hypot(dx, dz)
    // Buildings in the middle of a plot have no outward direction, so fan those out by index.
    const a = len > 0.2 ? Math.atan2(dz, dx) : (index * 2.4) % (Math.PI * 2)
    // Clear of the building's *own* footprint rather than a fixed 2.35: a big habitat blocks
    // more ground than a small one, and a standing spot inside that radius is a spot the
    // crew can never actually reach — it walks at the wall for as long as the thread lives.
    const blocked = (entry.mesh.userData.footprint || 1.2) * 0.8 + AGENT_RADIUS
    const stand = Math.max(2.35, blocked + 0.5)
    let site = new THREE.Vector3(b.x + Math.cos(a) * stand, 0, b.z + Math.sin(a) * stand)
    // Outward points straight off the zone for a building on its edge, and an astronaut
    // standing in the neighbouring repo's yard reads as belonging to that repo. The inside
    // of its own plot is always the better answer when the outside is somebody else's.
    const onPlot = (v) => {
      const cell = worldToHex(v.x, v.z)
      return plot.cellKeys.has(`${cell.q},${cell.r}`)
    }
    if (!onPlot(site)) {
      const inward = new THREE.Vector3(b.x - Math.cos(a) * stand, 0, b.z - Math.sin(a) * stand)
      if (onPlot(inward)) site = inward
    }
    // The grid is the one built for the last roster, so this is a best effort — but sites
    // are recomputed every poll, and anything walled in by a neighbour is nudged out to the
    // nearest ground somebody can stand on rather than left as a trap.
    if (this.nav?.isBlocked(site.x, site.z)) {
      const free = this.nav.nearestFree(site.x, site.z)
      if (free) site.set(this.nav.toWorld(free.ix), 0, this.nav.toWorld(free.iz))
    }
    return site
  }

  // ── per-frame ───────────────────────────────────────────────────────────────────────

  update(dt, elapsed, focus) {
    if (focus) this.sky.setFocus(focus)
    const cycled = this.sky.update(dt, elapsed, this.camera)
    if (cycled) this.settings.values.timeOfDay = this.sky.time

    const night = this.sky.nightFactor ?? 0
    buildingUniforms.uNight.value = night
    // One write turns every rotor in the colony.
    buildingUniforms.uTime.value = elapsed
    this.ship.update(dt, elapsed, night)
    this.deck.update(dt, elapsed, this.camera.position)
    // Re-dealt a few times a second rather than every frame. A thread changes what it is
    // doing on the timescale of a poll, and rebuilding the wall at sixty hertz would be two
    // hundred writes a frame to say the same thing it said on the last one.
    if (this.aboard) {
      this._deckAge = (this._deckAge || 0) + dt
      if (this._deckAge > 0.75) {
        this._deckAge = 0
        this.syncDeck()
        if (this.deck.consoleName) this.deck.setConsole(this.consoleFor(this.deck.consoleName))
        else this.deck.setConsole(this.consoleSummary())
      }
    }

    this._growBuildings(dt)
    this.astronauts.update(dt, elapsed)
    this.astronauts.updateRings(elapsed)
    this.indicators.update(this.astronauts.agents, elapsed, (a) => this._badgeFor(a))
    this._emit(dt, elapsed)
    this.particles.ambient(dt, this.camera, this.planet)
    this.particles.update(dt)
    this._updatePlots(night, elapsed)
    this._updateScaffolds()
    this._updateLabels(dt)
    this._updateSigns(dt)
  }

  _growBuildings(dt) {
    for (const [id, entry] of this.buildings) {
      // A running thread's site creeps upward while you watch it.
      if (!entry.retiring && this._isLive(id)) entry.target = Math.min(1, entry.target + LIVE_GROWTH * dt)
      const next = THREE.MathUtils.damp(entry.progress, entry.target, 1.8, dt)
      if (Math.abs(next - entry.progress) > 0.0005) {
        entry.progress = next
        entry.mesh.userData.setProgress(next)
      }
      if (entry.retiring && entry.progress <= 0.02) this._removeBuilding(id, entry)
    }
  }

  _isLive(id) {
    const thread = this.threads.get(id)
    return Boolean(thread && thread.running)
  }

  /** A site somebody is standing at: running, or stopped waiting on you. */
  _isActive(id) {
    const thread = this.threads.get(id)
    return Boolean(thread && (thread.running || thread.unread || thread.hasError))
  }

  _badgeFor(agent) {
    if (agent.state === 'spawning') return BADGE.spawning
    if (agent.state === 'leaving') return BADGE.leaving
    // Badges only appear once an astronaut has actually reached its post — a stream of
    // symbols bobbing over a walking crowd is noise.
    if (agent.state !== 'at-site') return BADGE.none
    return BADGE_FOR[agent.status] ?? BADGE.none
  }

  /** Particle emission, driven by what each astronaut is doing. */
  _emit(dt, elapsed) {
    if (!this.particles.enabled) return
    const full = this.settings.get('particles') === 'full'

    for (const agent of this.astronauts.agents) {
      if (agent.scale < 0.5) continue
      // What this one is standing on, which on a plot is the deck rather than the terrain
      // under it. Everything thrown off an astronaut has to land back on the same surface.
      const ground = agent.groundY || 0

      // The jetpack, while it is lit. Every frame rather than on a beat, because a flame
      // that stutters is a flame that is going out.
      if (agent.thrusting && agent.exhaust) {
        const ex = agent.exhaust
        const ed = agent.exhaustDir
        this.particles.flame(ex.x, ex.y, ex.z, ed.x, ed.y, ed.z, ground)
      }

      if (agent.state === 'at-site' && agent.status === 'working') {
        // Sparks on the downbeat of the hammer swing, not every frame.
        const swing = Math.sin(agent.workSwing)
        if (swing < -0.75 && !agent._sparked) {
          agent._sparked = true
          const c = this._c.set(0x9fe8c0)
          this.particles.weld(
            agent.pos.x + Math.sin(agent.yaw) * 0.55,
            agent.pos.y + 0.55,
            agent.pos.z + Math.cos(agent.yaw) * 0.55,
            c,
            ground
          )
        } else if (swing > 0) {
          agent._sparked = false
        }
      }

      if (agent.state === 'at-site' && agent.status === 'celebrating' && agent.hop > 0.18 && !agent._cheered) {
        agent._cheered = true
        this.particles.cheer(agent.pos.x, agent.pos.y, agent.pos.z, this._c.set(0xffc86a), ground)
      } else if (agent.hop < 0.05) {
        agent._cheered = false
      }

      if (agent.state === 'at-site' && agent.status === 'sleeping' && Math.random() < dt * 0.35) {
        this.particles.snooze(agent.pos.x + 0.2, agent.pos.y + 1.05, agent.pos.z + 0.15)
      }

      // Boot dust, on the footfall.
      if (full && (agent.walkAmp || 0) > 0.4) {
        const step = Math.sin(agent.phase)
        if (step < -0.9 && !agent._stepped) {
          agent._stepped = true
          this.particles.step(agent.pos.x, agent.pos.y, agent.pos.z, this._dustTint, ground)
        } else if (step > 0) {
          agent._stepped = false
        }
      }

      // The ramp notices anyone stepping on or off it.
      if (agent.state === 'spawning' || (agent.state === 'leaving' && agent.scale < 0.6)) {
        if (Math.random() < dt * 3) this.ship.ping()
      }
    }
  }

  _updatePlots(night, elapsed) {
    const urgent = this.urgentPlots
    for (const plot of this.plotOrder) plot.setNight(night, urgent?.has(plot.id) ?? false, elapsed)
  }

  _updateScaffolds() {
    const sites = []
    for (const [id, entry] of this.buildings) {
      // Scaffolding says a thread is running here — the README's own promise. It used to be
      // gated on the building being unfinished as well, which was fine while "unfinished"
      // was most of them and useless the moment buildings stopped standing in a hole.
      if (entry.progress <= 0.03) continue
      if (!this._isActive(id)) continue
      const p = entry.mesh.position
      sites.push({
        x: p.x,
        z: p.z,
        y: p.y,
        radius: (entry.mesh.userData.footprint || 1.4) + 0.35,
        height: Math.max(0.6, entry.mesh.userData.height * entry.progress + 0.5),
      })
    }
    this.scaffolds.update(sites)
  }

  // ── interaction ─────────────────────────────────────────────────────────────────────

  pick(ndcX, ndcY, aspect) {
    return this.astronauts.pick(this.camera, ndcX, ndcY, aspect)
  }

  agentFor(id) {
    return this.astronauts.byId.get(id)
  }

  setUiVisible(visible) {
    this.uiVisible = visible
    this._syncLabels()
  }

  _syncLabels() {
    // Visibility is per-label now; the group only ever hides everything at once.
    this.labelGroup.visible = true
  }

  dispose() {
    this.sky.dispose()
    this.ship.dispose()
    this.astronauts.dispose()
    this.indicators.dispose()
    this.particles.dispose()
    this.scaffolds.dispose()
    disposeTree(this.worldGroup)
    disposeTree(this.plotGroup)
    disposeTree(this.labelGroup)
    this.scene.remove(this.worldGroup, this.plotGroup, this.labelGroup)
  }
}

function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints) return
    o.geometry?.dispose()
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose())
    else o.material?.dispose()
  })
}
