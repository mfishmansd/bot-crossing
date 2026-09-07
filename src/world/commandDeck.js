import * as THREE from 'three'

/**
 * The ship's command deck — the room you stand in when you go aboard.
 *
 * **It is not inside the hull.** The ship is a little over three units across and an
 * astronaut is one and a quarter tall, so the inside of the model is a broom cupboard: a
 * room that fits in there is a room you cannot turn around in, and every wall of it would
 * fight the exterior geometry for the same space. So the deck is built once, a long way
 * under the world, and going aboard moves you to it. The room is sealed and the colony is
 * six hundred units above it, well past the fog, so there is nothing to see out of and
 * nothing to clip against — the two things that make interiors expensive both go away.
 *
 * The look is the wall of screens, lit by nothing but themselves. They are not decoration:
 * each panel is one thread, coloured by what that thread is actually doing, so the room is
 * the colony seen from the inside rather than from above. That is the whole difference
 * between a command deck and a set.
 */

/** Far enough under the colony that nothing up there shows through a seam. */
const ORIGIN = new THREE.Vector3(0, -600, 0)

const ROOM_R = 10.5
const WALL_H = 5.8
const ROWS = 5
/**
 * Thirty-six around rather than forty, on a wider wall: 180 panels, still comfortably more
 * than the repos there are to put on them, and each one thirty per cent wider and a quarter
 * taller than before. Panel count was never the constraint — legibility was.
 */
const COLS = 36
/**
 * How close to the wall you may walk.
 *
 * Set by the camera rather than by your face. The camera has to stay inside the shell too,
 * and it can only do that by shortening its leash — so the gap left here between where you
 * can stand and where the wall is has to be wide enough to hold the shortest leash that is
 * still a camera rather than a view from inside your own helmet. Two units and a bit buys
 * that; a wider walking circle buys a camera in the back of your head.
 */
const WALK_R = ROOM_R - 2.2

/**
 * Which row of the wall gets filled first.
 *
 * Panels are built from the floor up, and the colony hands its repos over busiest first, so
 * left alone the wall puts the repo you care most about at knee height and a repo with one
 * sleeping thread at eye level. The rows sit at 1.13, 2.29, 3.45, 4.61 and 5.77; you stand
 * with your eye near two. So it is filled from there outwards, and the quiet tail ends up
 * where a quiet tail belongs — overhead and underfoot.
 */
const ROW_FILL = [1, 0, 2, 3, 4]

/**
 * Panel colour by thread status. Deliberately the astronauts' own trim palette rather than
 * a new one: the wall has to be readable by somebody who has spent an hour reading those
 * same colours out on the surface, and a second vocabulary for the same six states is how
 * you build a dashboard nobody can parse at a glance.
 */
const STATUS_COLOR = {
  working: [0.34, 0.72, 0.45],
  waiting: [0.34, 0.55, 0.92],
  blocked: [0.92, 0.34, 0.34],
  celebrating: [0.92, 0.72, 0.34],
  // Quiet, not off. Two thirds of a real projects directory is asleep at any moment, and
  // the first pass had these down at 0.22 — which against a black room is indistinguishable
  // from a panel with nothing behind it, so a wall of a hundred and seventy repos read as
  // the dozen that happened to be busy. A sleeping repo is still a repo you own; it should
  // be legible and obviously not urgent, which is a job for contrast rather than for
  // switching it off.
  idle: [0.55, 0.57, 0.6],
  sleeping: [0.44, 0.46, 0.56],
}
/** No repo behind it at all. The one thing on the wall that really is switched off. */
const DARK = [0.05, 0.055, 0.075]

/**
 * The wall's contents, as one texture.
 *
 * Two hundred panels showing two hundred different things could be two hundred canvases and
 * two hundred draw calls, or it can be one atlas and one. It is the second, by exactly the
 * trick the crew's sixteen faces already use: every panel samples the same texture and a
 * per-instance offset picks which cell of it that panel reads. The mapping from panel to
 * cell never changes, so the offsets are written once at build and only the pixels are ever
 * redrawn.
 */
/**
 * Cell size, and it is not a free choice: the ratio has to be the panel's own or every
 * glyph on the wall is stretched, which in a monospace face is the first thing you notice.
 * A panel is 1.686 by 1.044, so 242 by 150 is that ratio to within two thousandths. The
 * absolute size is set by how far the texture is magnified in the room — a panel fills
 * something like five hundred pixels when you are stood in front of it, so a cell half this
 * size is a cell you can see the pixels of.
 */
const CELL_W = 242
const CELL_H = 150
const ATLAS_COLS = 15
const ATLAS_ROWS = 12

/** Fit a string to a width by cutting it and marking the cut, rather than letting it run on. */
function ellipsize(c, text, max) {
  if (c.measureText(text).width <= max) return text
  let cut = text
  while (cut.length > 1 && c.measureText(cut + '…').width > max) cut = cut.slice(0, -1)
  return cut + '…'
}

/** Greedy wrap. Two lines is all a panel this size can hold and still be read at a glance. */
function wrap(c, text, max, lines) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const out = []
  let line = ''
  for (const word of words) {
    const next = line ? line + ' ' + word : word
    if (c.measureText(next).width <= max) {
      line = next
      continue
    }
    if (line) out.push(line)
    if (out.length === lines - 1) {
      out.push(ellipsize(c, word + (words.indexOf(word) < words.length - 1 ? ' …' : ''), max))
      return out
    }
    line = word
  }
  if (line && out.length < lines) out.push(ellipsize(c, line, max))
  return out
}

/** "3 hours ago", in the coarsest unit that is still honest. */
function agoLabel(ms) {
  const m = Math.round(ms / 60000)
  if (m < 2) return 'just now'
  if (m < 60) return `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

export class CommandDeck {
  constructor(scene) {
    this.group = new THREE.Group()
    this.group.name = 'commandDeck'
    this.group.position.copy(ORIGIN)
    // Built dark. Nothing in here costs a frame until you walk into it.
    this.group.visible = false
    scene.add(this.group)

    this.scene = scene
    this._c = new THREE.Color()
    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._e = new THREE.Euler()
    this._v = new THREE.Vector3()
    this._one = new THREE.Vector3(1, 1, 1)
    /** Base colour and drift phase per panel, so the wall breathes instead of strobing. */
    this.panels = []
    /** What each panel is currently showing, by panel index; null where nothing is. */
    this._byPanel = []
    /** The panel in the middle of the view, or -1. Drawn brighter; see `setFocused`. */
    this.focused = -1
    /** Which repo the console is showing, or null when it is showing nothing. */
    this.consoleName = null

    this._buildShell()
    this._buildScreens()
    this._buildFittings()
  }

  /** The deck plate you stand on. */
  get floorY() {
    return ORIGIN.y
  }

  /** Where you arrive, and the circle you may walk in. */
  entry(out = new THREE.Vector3()) {
    return out.set(ORIGIN.x, ORIGIN.y, ORIGIN.z + WALK_R * 0.72)
  }

  bounds() {
    return { x: ORIGIN.x, z: ORIGIN.z, r: WALK_R }
  }

  /**
   * What the camera has to stay inside — the shell itself rather than the walking circle,
   * pulled in far enough that it never sits exactly on a panel and reads it edge-on.
   */
  cameraBounds() {
    return {
      x: ORIGIN.x,
      z: ORIGIN.z,
      r: ROOM_R - 0.45,
      ceiling: ORIGIN.y + WALL_H + 0.9 - 0.35,
      // Looking up drops the camera below what it is aiming at, so the deck plate is a wall
      // like any other — without this, tipping far enough back puts you under the floor.
      floor: ORIGIN.y + 0.3,
    }
  }

  /**
   * Floor, ceiling and the hull band behind the screens. Unlit materials throughout: there
   * is no sun six hundred units down, and a standard material in a room whose only light is
   * its screens is a room that renders black.
   */
  _buildShell() {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(ROOM_R, 48),
      new THREE.MeshBasicMaterial({ color: 0x14161c })
    )
    floor.rotation.x = -Math.PI / 2
    this.group.add(floor)

    // An inlaid ring. A plain disc reads as no size at all; this gives the eye something to
    // judge the room against.
    const inlay = new THREE.Mesh(
      new THREE.RingGeometry(WALK_R * 0.52, WALK_R * 0.56, 64),
      new THREE.MeshBasicMaterial({ color: 0x2b6f8f, toneMapped: false })
    )
    inlay.rotation.x = -Math.PI / 2
    inlay.position.y = 0.012
    this.group.add(inlay)

    const ceiling = new THREE.Mesh(
      new THREE.CircleGeometry(ROOM_R, 48),
      new THREE.MeshBasicMaterial({ color: 0x0b0d12, side: THREE.BackSide })
    )
    ceiling.rotation.x = -Math.PI / 2
    ceiling.position.y = WALL_H + 0.9
    this.group.add(ceiling)

    // Sealed, because the reason this room may ignore the world above is that you can never
    // see past it.
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(ROOM_R + 0.05, ROOM_R + 0.05, WALL_H + 0.9, 48, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x0d0f15, side: THREE.BackSide })
    )
    shell.position.y = (WALL_H + 0.9) / 2
    this.group.add(shell)
  }

  /**
   * Two hundred panels in one instanced mesh — one draw call for the entire wall. Colour is
   * the only thing that differs between them, which is what instancing is for and exactly
   * how the crew out on the surface is already drawn.
   */
  _buildScreens() {
    const count = ROWS * COLS
    const panelW = ((2 * Math.PI * ROOM_R) / COLS) * 0.92
    const panelH = (WALL_H / ROWS) * 0.9

    this.atlas = document.createElement('canvas')
    this.atlas.width = CELL_W * ATLAS_COLS
    this.atlas.height = CELL_H * ATLAS_ROWS
    this.atlasCtx = this.atlas.getContext('2d')
    this.atlasCtx.fillStyle = '#000'
    this.atlasCtx.fillRect(0, 0, this.atlas.width, this.atlas.height)

    const texture = new THREE.CanvasTexture(this.atlas)
    texture.colorSpace = THREE.SRGBColorSpace
    // No mipmaps, deliberately. A mip of an atlas averages across cell borders, so the
    // bottom line of one panel bleeds into the top of its neighbour's — and the panels are
    // never far enough away to have wanted a mip in the first place.
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    texture.anisotropy = 4
    this.atlasTexture = texture

    const geo = new THREE.PlaneGeometry(panelW, panelH)
    // Which cell each panel reads. Fixed for the life of the room: panel i is always cell i,
    // so a thread moving between panels is a redraw and never a rewrite of this buffer.
    const cells = new Float32Array(count * 2)
    for (let i = 0; i < count; i++) {
      cells[i * 2] = (i % ATLAS_COLS) / ATLAS_COLS
      cells[i * 2 + 1] = 1 - (Math.floor(i / ATLAS_COLS) + 1) / ATLAS_ROWS
    }
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2))

    const mat = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCellScale = { value: new THREE.Vector2(1 / ATLAS_COLS, 1 / ATLAS_ROWS) }
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec2 aCell;
           uniform vec2 uCellScale;`
        )
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n           vMapUv = uv * uCellScale + aCell;`)
    }
    this.screens = new THREE.InstancedMesh(geo, mat, count)
    this.screens.frustumCulled = false

    let i = 0
    for (let row = 0; row < ROWS; row++) {
      const y = 0.55 + (row + 0.5) * (WALL_H / ROWS)
      for (let col = 0; col < COLS; col++) {
        const a = (col / COLS) * Math.PI * 2
        // Faces inward, so the angle round the wall doubles as the rotation.
        this._e.set(0, a + Math.PI, 0)
        this._q.setFromEuler(this._e)
        this._v.set(Math.sin(a) * ROOM_R, y, Math.cos(a) * ROOM_R)
        this._m.compose(this._v, this._q, this._one)
        this.screens.setMatrixAt(i, this._m)
        this.screens.setColorAt(i, this._c.setRGB(DARK[0], DARK[1], DARK[2]))
        this.panels.push({ base: DARK, phase: (i * 0.618) % 1, gain: 1 })
        i++
      }
    }
    this.screens.instanceMatrix.needsUpdate = true
    this.group.add(this.screens)

    // The order repos are dealt round the wall: eye level first, then out. Built once here
    // rather than sorted per sync, because it depends on nothing that ever changes.
    this.order = []
    for (const row of ROW_FILL) {
      for (let col = 0; col < COLS; col++) this.order.push(row * COLS + col)
    }

    this._drawAll([])
  }

  /**
   * Draw one panel's worth of the atlas.
   *
   * White on black throughout, because the per-instance colour multiplies whatever is here
   * — the panel is tinted by what its thread is doing, so drawing this in colour would mean
   * mixing two colours to say one thing. Brightness carries the hierarchy instead, the way
   * a monochrome terminal always did.
   */
  _drawCell(index, entry) {
    const c = this.atlasCtx
    const x = (index % ATLAS_COLS) * CELL_W
    const y = Math.floor(index / ATLAS_COLS) * CELL_H
    c.save()
    c.translate(x, y)
    c.beginPath()
    c.rect(0, 0, CELL_W, CELL_H)
    c.clip()

    c.fillStyle = '#000'
    c.fillRect(0, 0, CELL_W, CELL_H)

    if (!entry) {
      // A dark panel is a panel with no thread behind it. It gets the faintest of grids so
      // that it still reads as a screen that is switched off rather than a hole in the wall.
      c.strokeStyle = 'rgba(255,255,255,0.05)'
      c.lineWidth = 1
      for (let gy = 20; gy < CELL_H; gy += 25) {
        c.beginPath()
        c.moveTo(8, gy)
        c.lineTo(CELL_W - 8, gy)
        c.stroke()
      }
      c.restore()
      return
    }

    const pad = 15
    const width = CELL_W - pad * 2

    // The repo, loudest: it is what the zone outside is called, what the sidebar lists, and
    // what you are scanning the wall for.
    c.font = 'bold 24px ui-monospace, SFMono-Regular, Menlo, monospace'
    c.fillStyle = 'rgba(255,255,255,0.96)'
    c.fillText(ellipsize(c, entry.project || '—', width), pad, 31)

    c.strokeStyle = 'rgba(255,255,255,0.22)'
    c.lineWidth = 1.4
    c.beginPath()
    c.moveTo(pad, 42.5)
    c.lineTo(CELL_W - pad, 42.5)
    c.stroke()

    // The count, then only the states worth naming. A repo where nothing is wrong says so
    // by listing nothing — a breakdown that always prints six numbers, four of them zero,
    // is one nobody reads.
    const counts = entry.counts || {}
    const notable = []
    if (counts.blocked) notable.push(counts.blocked + ' stuck')
    if (counts.waiting) notable.push(counts.waiting + ' need you')
    if (counts.working) notable.push(counts.working + ' running')
    c.font = '19px ui-monospace, SFMono-Regular, Menlo, monospace'
    c.fillStyle = 'rgba(255,255,255,0.82)'
    const total = entry.total === 1 ? '1 thread' : entry.total + ' threads'
    c.fillText(ellipsize(c, total, width), pad, 66)
    if (notable.length) {
      c.fillStyle = 'rgba(255,255,255,0.66)'
      c.fillText(ellipsize(c, notable.join(' · '), width), pad, 89)
    }

    // And the worst thread's own words, if there is room left for them — one line, because
    // this is the reason the repo is lit rather than the whole of what it is doing.
    if (entry.title) {
      c.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace'
      c.fillStyle = 'rgba(255,255,255,0.44)'
      c.fillText(ellipsize(c, entry.title, width), pad, notable.length ? 112 : 94)
    }

    // The status word, and the harness. The split between them is measured rather than
    // guessed, or a long harness name loses its tail to make room for nothing.
    c.font = 'bold 17px ui-monospace, SFMono-Regular, Menlo, monospace'
    c.fillStyle = 'rgba(255,255,255,0.9)'
    const status = (entry.status || '').toUpperCase()
    const statusW = c.measureText(status).width
    c.fillText(ellipsize(c, status, width * 0.55), pad, CELL_H - 15)
    if (entry.harness) {
      c.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace'
      c.fillStyle = 'rgba(255,255,255,0.45)'
      const label = ellipsize(c, entry.harness, width - statusW - 12)
      c.fillText(label, CELL_W - pad - c.measureText(label).width, CELL_H - 15)
    }
    if (entry.moved) {
      // Something happened here since you were last aboard. A dot in the corner, in the
      // console's own blue rather than a status colour, because it is not a state — it is
      // a difference, and it is gone the next time you come in.
      c.fillStyle = '#3f9ec4'
      c.beginPath()
      c.arc(CELL_W - pad - 6, 20, 6, 0, Math.PI * 2)
      c.fill()
    }
    c.restore()
  }

  /** Redraw every cell. Only ever called when what the wall is showing actually changed. */
  _drawAll(entries) {
    for (let i = 0; i < this.panels.length; i++) this._drawCell(i, entries[i])
    this.atlasTexture.needsUpdate = true
  }

  /** A plinth to walk around, and two dim fills so the floor is not a hole. */
  _buildFittings() {
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.35, 0.62, 24),
      new THREE.MeshBasicMaterial({ color: 0x1b1f27 })
    )
    plinth.position.y = 0.31
    this.group.add(plinth)

    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(1.02, 1.02, 0.05, 24),
      new THREE.MeshBasicMaterial({ color: 0x3f9ec4, toneMapped: false })
    )
    top.position.y = 0.64
    this.group.add(top)

    this._buildConsole()

    // Unlit screens throw no light of their own, so these stand in for the bounce.
    const fill = new THREE.PointLight(0x74b8dc, 6, 26, 2)
    fill.position.set(0, 2.4, 0)
    this.group.add(fill)
    const low = new THREE.PointLight(0x3d6f96, 3, 18, 2)
    low.position.set(0, 0.7, 0)
    this.group.add(low)
  }

  setAboard(on) {
    this.group.visible = on
  }

  /**
   * Point the wall at the colony, one panel per repo. Dealt round in order, and a colony
   * with fewer repos than panels leaves the rest dark rather than repeating itself — a wall
   * looping the same six repos twenty times looks busy and says nothing.
   */
  sync(entries) {
    const panels = this.panels
    // Entries arrive in the colony's order and panels are in the wall's; `order` is the map
    // between them, so everything below indexes by panel and never by rank.
    const byPanel = new Array(panels.length).fill(null)
    for (let k = 0; k < entries.length && k < this.order.length; k++) byPanel[this.order[k]] = entries[k]
    this._byPanel = byPanel
    // Redrawing two hundred cells of text is cheap next to a poll and ruinous next to a
    // frame, so it happens only when the wall is actually showing something else. Colour
    // still follows every sync: a thread changing what it is doing is a tint, not a redraw.
    const signature = byPanel
      .map((e) => (e ? [e.id, e.total, e.counts.blocked, e.counts.waiting, e.counts.working, e.title, e.moved ? 1 : 0].join('\u0000') : ''))
      .join('\u0001')
    if (signature !== this._signature) {
      this._signature = signature
      this._drawAll(byPanel)
    }
    for (let i = 0; i < panels.length; i++) {
      const status = byPanel[i] && byPanel[i].status
      panels[i].base = (status && STATUS_COLOR[status]) || DARK
      // A panel just handed a thread flares, so the wall visibly reacts to a scan landing
      // instead of quietly becoming a different wall.
      if (status) panels[i].gain = 2.2
    }
  }

  update(dt, elapsed, cameraPos) {
    if (!this.group.visible) return
    if (cameraPos && this.console.visible) {
      // Yaw only. Pitching to face a camera that is above you tips the screen back like a
      // tray, and a screen that leans is one that looks like it is about to fall over.
      this.console.rotation.y = Math.atan2(cameraPos.x - ORIGIN.x, cameraPos.z - ORIGIN.z)
    }
    const panels = this.panels
    const c = this._c
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i]
      // Shallower than it was, for the same reason the quiet colours came up: a panel that
      // dips to seven tenths is a panel that spends half its time unreadable.
      const flicker = 0.86 + 0.14 * Math.sin(elapsed * 1.7 + p.phase * Math.PI * 2)
      p.gain = p.gain > 1 ? Math.max(1, p.gain - dt * 1.6) : 1
      // The panel you are looking at is held bright and still. Brighter says "this one";
      // still says it, too — a thing that stops breathing when you look at it is a thing
      // that has noticed you.
      const k = i === this.focused ? 1.7 : flicker * p.gain
      c.setRGB(p.base[0] * k, p.base[1] * k, p.base[2] * k)
      this.screens.setColorAt(i, c)
    }
    this.screens.instanceColor.needsUpdate = true
  }

  /**
   * The console: one screen floating over the plinth, showing the repo you are facing.
   *
   * The wall says what every repo is doing; this says what one of them *is* — its readme's
   * own title and first sentence, the same answer `R` gives on the map — and lists its
   * threads worst first, which is the queue Enter works through. It turns to face you, yaw
   * only, exactly like the boards on the surface: a screen you can read from anywhere in the
   * room without it ever appearing to move.
   */
  _buildConsole() {
    this.consoleCanvas = document.createElement('canvas')
    this.consoleCanvas.width = 640
    this.consoleCanvas.height = 400
    this.consoleCtx = this.consoleCanvas.getContext('2d')

    const texture = new THREE.CanvasTexture(this.consoleCanvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    texture.anisotropy = 4
    this.consoleTexture = texture

    // 2.56 by 1.6: the canvas's own ratio, for the same reason the wall's cells match the
    // wall's panels. Sat just above head height so it never hides the astronaut from you.
    const geo = new THREE.PlaneGeometry(2.56, 1.6)
    const mat = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true, opacity: 0.94 })
    this.console = new THREE.Mesh(geo, mat)
    this.console.position.set(0, 2.15, 0)
    this.console.visible = false
    this.group.add(this.console)

    // A thin stem from the plinth, so the screen reads as mounted rather than floating.
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6),
      new THREE.MeshBasicMaterial({ color: 0x3f9ec4, toneMapped: false })
    )
    stem.position.set(0, 0.99, 0)
    this.group.add(stem)

    this._drawConsole(null)
  }

  /**
   * Show a repo on the console, or nothing. `info` is assembled by the colony, which owns
   * both the readme cache and the threads; the deck only knows how to draw it. Redrawn only
   * when what it says has changed, for the same reason as the wall.
   */
  setConsole(info) {
    const signature = !info
      ? ''
      : info.summary
        ? ['summary', info.threads, info.repos, info.waiting, info.working, info.blocked, info.done, info.moved, info.since].join('\u0000')
        : [info.project, info.title, info.tagline, info.readmeState, info.cursor, ...info.threads.map((t) => t.status + t.title + (t.preview || ''))].join('\u0000')
    this.consoleName = info && !info.summary ? info.project : null
    this.console.visible = Boolean(info)
    if (signature === this._consoleSignature) return
    this._consoleSignature = signature
    this._drawConsole(info)
  }

  _drawConsole(info) {
    const c = this.consoleCtx
    const W = this.consoleCanvas.width
    const H = this.consoleCanvas.height
    c.clearRect(0, 0, W, H)
    c.fillStyle = 'rgba(4,7,12,0.96)'
    c.fillRect(0, 0, W, H)
    c.strokeStyle = 'rgba(63,158,196,0.9)'
    c.lineWidth = 3
    c.strokeRect(1.5, 1.5, W - 3, H - 3)
    if (!info) {
      this.consoleTexture.needsUpdate = true
      return
    }
    if (info.summary) {
      this._drawSummary(info)
      return
    }

    const pad = 26
    const width = W - pad * 2
    let y = 52

    // The repo, then what its readme calls it if that is a different thing. Most of the
    // time they agree and the second line is skipped rather than said twice.
    c.font = 'bold 34px ui-monospace, SFMono-Regular, Menlo, monospace'
    c.fillStyle = 'rgba(255,255,255,0.97)'
    c.fillText(ellipsize(c, info.project, width), pad, y)
    y += 14

    c.strokeStyle = 'rgba(63,158,196,0.55)'
    c.lineWidth = 2
    c.beginPath()
    c.moveTo(pad, y)
    c.lineTo(W - pad, y)
    c.stroke()
    y += 34

    c.font = '20px ui-monospace, SFMono-Regular, Menlo, monospace'
    if (info.readmeState === 'loading') {
      c.fillStyle = 'rgba(255,255,255,0.4)'
      c.fillText('reading the readme…', pad, y)
      y += 30
    } else if (!info.title && !info.tagline) {
      c.fillStyle = 'rgba(255,255,255,0.4)'
      c.fillText('no readme', pad, y)
      y += 30
    } else {
      if (info.title && info.title.toLowerCase() !== info.project.toLowerCase()) {
        c.fillStyle = 'rgba(159,199,242,0.95)'
        c.fillText(ellipsize(c, info.title, width), pad, y)
        y += 28
      }
      if (info.tagline) {
        c.fillStyle = 'rgba(255,255,255,0.78)'
        for (const line of wrap(c, info.tagline, width, 3)) {
          c.fillText(line, pad, y)
          y += 26
        }
      }
    }
    y += 12

    // The queue: this repo's threads, worst first, however many fit. The status word is
    // the wall's colour for the same state, so the two read as one system.
    c.font = 'bold 17px ui-monospace, SFMono-Regular, Menlo, monospace'
    c.fillStyle = 'rgba(255,255,255,0.5)'
    const total = info.threads.length === 1 ? '1 thread' : info.threads.length + ' threads'
    c.fillText(total.toUpperCase(), pad, y)
    y += 26
    const rowH = 27
    const cursor = Math.max(0, Math.min(info.cursor || 0, info.threads.length - 1))
    // The picked thread's last words go along the bottom, so the list gives up two rows
    // for them when there are any to show.
    const said = (info.threads[cursor] && info.threads[cursor].preview) || ''
    const reserve = said ? 58 : 0
    const room = Math.max(0, Math.floor((H - 22 - reserve - y) / rowH))
    // The list scrolls to keep the picked row on the screen, and no further: a list that
    // recentres on every keypress is one whose rows never stay where you left them.
    const start = Math.max(0, Math.min(cursor - room + 1, info.threads.length - room))
    const shown = info.threads.slice(start, start + room)
    const mark = 14
    shown.forEach((t, k) => {
      const picked = start + k === cursor
      if (picked) {
        c.fillStyle = 'rgba(63,158,196,0.16)'
        c.fillRect(pad - 8, y - 19, W - pad * 2 + 16, rowH)
        c.fillStyle = 'rgba(159,199,242,0.95)'
        c.fillText('▸', pad - 4, y)
      }
      const col = STATUS_COLOR[t.status] || STATUS_COLOR.idle
      c.font = 'bold 16px ui-monospace, SFMono-Regular, Menlo, monospace'
      c.fillStyle = `rgb(${col[0] * 255 | 0},${col[1] * 255 | 0},${col[2] * 255 | 0})`
      c.fillText(t.status.toUpperCase(), pad + mark, y)
      const wordW = 118
      c.font = '17px ui-monospace, SFMono-Regular, Menlo, monospace'
      c.fillStyle = picked ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.8)'
      c.fillText(ellipsize(c, t.title || '(untitled)', width - wordW - mark), pad + mark + wordW, y)
      y += rowH
    })
    const above = start
    const below = info.threads.length - (start + shown.length)
    if (above || below) {
      c.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace'
      c.fillStyle = 'rgba(255,255,255,0.4)'
      const parts = []
      if (above) parts.push(`${above} above`)
      if (below) parts.push(`${below} more`)
      c.fillText(`… ${parts.join(' · ')}`, pad, y)
    }
    if (said) {
      c.strokeStyle = 'rgba(63,158,196,0.35)'
      c.lineWidth = 1
      c.beginPath()
      c.moveTo(pad, H - 58)
      c.lineTo(W - pad, H - 58)
      c.stroke()
      c.font = 'italic 16px ui-monospace, SFMono-Regular, Menlo, monospace'
      c.fillStyle = 'rgba(255,255,255,0.62)'
      const lines = wrap(c, `“${said.replace(/\s+/g, ' ').trim()}”`, width, 2)
      lines.forEach((line, k) => c.fillText(line, pad, H - 36 + k * 20))
    }
    this.consoleTexture.needsUpdate = true
  }

  /**
   * The console with nothing faced: the colony at a glance. Four numbers in the wall's own
   * colours for the four states that matter, then the size of the place. This is what the
   * middle of the room says the moment you walk in, before you have looked at anything.
   */
  _drawSummary(info) {
    const c = this.consoleCtx
    const W = this.consoleCanvas.width
    const H = this.consoleCanvas.height
    const pad = 26

    c.font = 'bold 30px ui-monospace, SFMono-Regular, Menlo, monospace'
    c.fillStyle = 'rgba(255,255,255,0.97)'
    c.fillText('THE COLONY', pad, 50)
    c.strokeStyle = 'rgba(63,158,196,0.55)'
    c.lineWidth = 2
    c.beginPath()
    c.moveTo(pad, 64)
    c.lineTo(W - pad, 64)
    c.stroke()

    const cells = [
      ['need you', info.waiting, STATUS_COLOR.waiting],
      ['building', info.working, STATUS_COLOR.working],
      ['stuck', info.blocked, STATUS_COLOR.blocked],
      ['shipped', info.done, STATUS_COLOR.celebrating],
    ]
    const colW = (W - pad * 2) / cells.length
    cells.forEach(([label, n, col], i) => {
      const x = pad + colW * i + colW / 2
      c.textAlign = 'center'
      // A zero is drawn quiet rather than left out: four columns that are always the same
      // four is a layout you can read without looking, which is the point of a dashboard.
      const alive = n > 0
      c.font = 'bold 64px ui-monospace, SFMono-Regular, Menlo, monospace'
      c.fillStyle = alive ? `rgb(${(col[0] * 255) | 0},${(col[1] * 255) | 0},${(col[2] * 255) | 0})` : 'rgba(255,255,255,0.22)'
      c.fillText(String(n), x, 178)
      c.font = '17px ui-monospace, SFMono-Regular, Menlo, monospace'
      c.fillStyle = alive ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)'
      c.fillText(label, x, 208)
    })
    c.textAlign = 'left'

    c.font = '20px ui-monospace, SFMono-Regular, Menlo, monospace'
    c.fillStyle = 'rgba(255,255,255,0.72)'
    const threads = info.threads === 1 ? '1 thread' : `${info.threads} threads`
    const repos = info.repos === 1 ? '1 repo' : `${info.repos} repos`
    c.fillText(`${threads} across ${repos}`, pad, 292)

    if (info.since) {
      // The question you actually walk in with.
      const ago = agoLabel(Date.now() - info.since)
      c.font = '18px ui-monospace, SFMono-Regular, Menlo, monospace'
      c.fillStyle = info.moved ? 'rgba(159,199,242,0.95)' : 'rgba(255,255,255,0.5)'
      const what = info.moved === 1 ? '1 repo moved' : `${info.moved} repos moved`
      c.fillText(`${what} since your last visit, ${ago}`, pad, 326)
    }

    c.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace'
    c.fillStyle = 'rgba(255,255,255,0.38)'
    c.fillText('look at a panel for its repo · N next needing you · X sweeps the idle', pad, H - 30)
    this.consoleTexture.needsUpdate = true
  }

  /** The panel a repo is on, or -1. */
  panelOf(project) {
    for (let i = 0; i < this._byPanel.length; i++) {
      if (this._byPanel[i] && this._byPanel[i].project === project) return i
    }
    return -1
  }

  /** What a panel is showing, or null for a dark one. */
  entryAt(panel) {
    return panel >= 0 ? this._byPanel[panel] || null : null
  }

  setFocused(panel) {
    this.focused = panel
  }

  /** A panel's centre, in world units. */
  panelCenter(panel, out = new THREE.Vector3()) {
    const col = panel % COLS
    const row = Math.floor(panel / COLS)
    const a = (col / COLS) * Math.PI * 2
    return out.set(
      ORIGIN.x + Math.sin(a) * ROOM_R,
      ORIGIN.y + 0.55 + (row + 0.5) * (WALL_H / ROWS),
      ORIGIN.z + Math.cos(a) * ROOM_R
    )
  }

  /**
   * Which panel the middle of the view lands on.
   *
   * The camera sits behind the point it is aimed at, so the line of sight runs from the
   * camera through that point and on to the wall; this is where it meets the wall, as a
   * panel index, or -1 in the gaps above the top row and below the bottom one. Computed
   * from the camera's actual bearing and pitch rather than the ones it is easing toward,
   * so a selection follows what is on screen, not what will be.
   */
  facing(aim, azimuth, polar) {
    const sinP = Math.sin(polar)
    const dx = -sinP * Math.sin(azimuth)
    const dy = -Math.cos(polar)
    const dz = -sinP * Math.cos(azimuth)
    const ox = aim.x - ORIGIN.x
    const oz = aim.z - ORIGIN.z
    // Where the ray leaves the room's circle: the positive root of |o + t·d|² = r².
    const a = dx * dx + dz * dz
    if (a < 1e-9) return -1
    const b = ox * dx + oz * dz
    const c = ox * ox + oz * oz - ROOM_R * ROOM_R
    const disc = b * b - a * c
    if (disc <= 0) return -1
    const t = (-b + Math.sqrt(disc)) / a
    const hy = aim.y - ORIGIN.y + t * dy
    const row = Math.floor((hy - 0.55) / (WALL_H / ROWS))
    if (row < 0 || row >= ROWS) return -1
    const angle = Math.atan2(ox + t * dx, oz + t * dz)
    let col = Math.round((angle / (Math.PI * 2)) * COLS) % COLS
    if (col < 0) col += COLS
    return row * COLS + col
  }

  /**
   * The next panel round the wall that wants you, starting just past the one given. Swept
   * column by column and eye-level row first within each, so pressing it repeatedly walks
   * you round the room rather than bouncing you between the ceiling and the floor.
   */
  nextUrgent(from) {
    // One fixed lap of the room — column by column, eye-level row first within each — and
    // the search simply starts one place past wherever you are on it. The first version
    // stepped by column and took the first urgent panel in each, which silently dropped
    // every column's second urgent repo: fifty-four wanted, thirty-two ever reached.
    if (!this._sweep) {
      this._sweep = []
      this._sweepIndex = new Int32Array(ROWS * COLS)
      for (let col = 0; col < COLS; col++) {
        for (const row of ROW_FILL) {
          this._sweepIndex[row * COLS + col] = this._sweep.length
          this._sweep.push(row * COLS + col)
        }
      }
    }
    const lap = this._sweep
    const start = from >= 0 ? this._sweepIndex[from] : -1
    for (let step = 1; step <= lap.length; step++) {
      const panel = lap[(start + step) % lap.length]
      const entry = this._byPanel[panel]
      if (entry && (entry.status === 'waiting' || entry.status === 'blocked')) return panel
    }
    return -1
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) {
        if (o.material.map) o.material.map.dispose()
        o.material.dispose()
      }
    })
    this.scene.remove(this.group)
  }
}
