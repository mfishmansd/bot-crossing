/**
 * Sound, synthesised. Nothing is downloaded and nothing is shipped: a jetpack is filtered
 * noise, a hop is a short rising tone, a door is a falling one, a job done is two notes.
 * WebAudio makes every one of those from arithmetic, which keeps the runtime's dependency
 * count where the maintainer wants it and the repository free of somebody else's samples.
 *
 * The context is only ever made on a gesture — browsers refuse to start audio before one —
 * so the first key or click of the session is what switches the sound on, and until then
 * every call here is a no-op rather than an error.
 */
export class Sound {
  constructor(settings) {
    this.settings = settings
    this.ctx = null
    this.master = null
    this.jetGain = null
    this._jetOn = false
  }

  /** Build the graph, once, on a gesture. Returns whether there is anything to play through. */
  ensure() {
    if (this.ctx) return true
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return false
    this.ctx = new AC()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.settings.get('sound') ? 0.6 : 0
    this.master.connect(this.ctx.destination)
    this._buildJet()
    return true
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume()
  }

  onSettingsChanged(changed) {
    if (!changed.has('sound') || !this.master) return
    this.master.gain.setTargetAtTime(this.settings.get('sound') ? 0.6 : 0, this.ctx.currentTime, 0.05)
  }

  /**
   * The jetpack: a loop of white noise through a band-pass, sitting silent until it is
   * wanted. Ramped in and out rather than switched, because a pack that clicks on is a
   * relay and one that breathes on is a flame.
   */
  _buildJet() {
    const ctx = this.ctx
    const len = ctx.sampleRate * 2
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 900
    bp.Q.value = 0.7
    this.jetGain = ctx.createGain()
    this.jetGain.gain.value = 0
    src.connect(bp).connect(this.jetGain).connect(this.master)
    src.start()
  }

  jet(on) {
    if (!this.ctx || on === this._jetOn) return
    this._jetOn = on
    this.jetGain.gain.setTargetAtTime(on ? 0.35 : 0, this.ctx.currentTime, on ? 0.08 : 0.15)
  }

  /** One enveloped tone. Everything short in here is this with different numbers. */
  _blip(freq, dur, type = 'sine', vol = 0.25, slideTo = null, delay = 0) {
    if (!this.ctx) return
    const t = this.ctx.currentTime + delay
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + dur + 0.03)
  }

  hop() {
    this._blip(220, 0.12, 'triangle', 0.2, 330)
  }

  /** A door, a hatch, a teleport: something falling away behind you. */
  whoosh() {
    this._blip(880, 0.35, 'sine', 0.16, 180)
  }

  /** A job done. */
  chime() {
    this._blip(660, 0.22, 'sine', 0.2)
    this._blip(990, 0.3, 'sine', 0.16, null, 0.09)
  }

  /** The console noticing something. */
  tick() {
    this._blip(1200, 0.05, 'square', 0.05)
  }
}
