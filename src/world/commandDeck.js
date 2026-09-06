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

const ROOM_R = 9
const WALL_H = 4.6
const ROWS = 5
const COLS = 40
/** How close to the wall you may walk, so you never press your face into a screen. */
const WALK_R = ROOM_R - 1.1

/**
 * Panel colour by thread status. Deliberately the astronauts' own trim palette rather than
 * a new one: the wall has to be readable by somebody who has spent an hour reading those
 * same colours out on the surface, and a second vocabulary for the same six states is how
 * you build a dashboard nobody can parse at a glance.
 */
const STATUS_COLOR = {
  working: [0.31, 0.6, 0.39],
  waiting: [0.31, 0.49, 0.79],
  blocked: [0.79, 0.31, 0.31],
  celebrating: [0.79, 0.63, 0.31],
  idle: [0.3, 0.31, 0.33],
  sleeping: [0.22, 0.22, 0.3],
}
const DARK = [0.06, 0.065, 0.085]

/**
 * One texture shared by every panel, drawn once: ragged bars that read as lines of text at
 * any distance you can actually stand from a wall. Two hundred canvases of real text would
 * cost two hundred textures and still be illegible — what carries meaning here is the
 * colour and which panels are lit, and the bars are what stop a lit panel being a flat
 * rectangle.
 */
function screenTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 96
  const c = canvas.getContext('2d')
  c.fillStyle = '#000'
  c.fillRect(0, 0, 128, 96)

  // Seeded rather than random: two panels differing between reloads buys nothing, and a
  // fixed scribble is one you can eyeball twice and compare.
  let seed = 0x2f6b
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  c.fillStyle = '#fff'
  for (let y = 6; y < 92; y += 7) {
    // An indent every few lines reads as structure rather than noise. The eye finds the
    // shape of code in it, which is the entire trick.
    const indent = 6 + Math.floor(rand() * 3) * 7
    let x = indent
    while (x < 120) {
      const w = 4 + rand() * 22
      if (x + w > 120) break
      c.globalAlpha = 0.25 + rand() * 0.6
      c.fillRect(x, y, w, 2.4)
      x += w + 3 + rand() * 5
    }
  }
  c.globalAlpha = 1

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  return texture
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

    const geo = new THREE.PlaneGeometry(panelW, panelH)
    const mat = new THREE.MeshBasicMaterial({ map: screenTexture(), toneMapped: false })
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
        // The golden-ratio stride is what keeps neighbours out of step later.
        this.panels.push({ base: DARK, phase: (i * 0.618) % 1, gain: 1 })
        i++
      }
    }
    this.screens.instanceMatrix.needsUpdate = true
    this.group.add(this.screens)
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
   * Point the wall at the colony. Threads are dealt round the panels in order, and a colony
   * with fewer threads than panels leaves the rest dark rather than repeating itself — a
   * wall looping the same six threads twenty times looks busy and says nothing.
   */
  sync(statuses) {
    const panels = this.panels
    for (let i = 0; i < panels.length; i++) {
      const status = statuses[i]
      panels[i].base = (status && STATUS_COLOR[status]) || DARK
      // A panel that has just been handed a thread flares, so the wall visibly reacts to a
      // scan landing instead of quietly becoming a different wall.
      if (status) panels[i].gain = 2.2
    }
  }

  update(dt, elapsed) {
    if (!this.group.visible) return
    const panels = this.panels
    const c = this._c
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i]
      const flicker = 0.72 + 0.28 * Math.sin(elapsed * 1.7 + p.phase * Math.PI * 2)
      p.gain = p.gain > 1 ? Math.max(1, p.gain - dt * 1.6) : 1
      const k = flicker * p.gain
      c.setRGB(p.base[0] * k, p.base[1] * k, p.base[2] * k)
      this.screens.setColorAt(i, c)
    }
    this.screens.instanceColor.needsUpdate = true
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
