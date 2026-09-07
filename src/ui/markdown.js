/**
 * A small markdown renderer, for the one document this app shows: a repo's README.
 *
 * Deliberately not `marked`. The whole surface here is "the subset a README actually uses",
 * which is a much smaller language than CommonMark — headings, lists, fences, tables, links
 * and emphasis — and the two things that make a general parser worth its weight, extension
 * points and spec fidelity, buy this page nothing. What it would buy is a dependency in the
 * bundle of a toy that currently has exactly one.
 *
 * Two decisions are worth stating because they are refusals rather than omissions:
 *
 *   - **Raw HTML is stripped to its text.** A README is a file on your disk, not a document
 *     from the network, but it is still not markup this page wrote, and it lands inside the
 *     same DOM as the HUD. Escaping everything and then dropping tag-shaped runs means the
 *     worst a hostile README can do is show you its own angle brackets.
 *   - **Images are dropped entirely**, badges included. Rendering them would have a page
 *     that otherwise talks to nothing but localhost start fetching from shields.io the
 *     moment you clicked a zone, and a row of build badges is noise in a 320px sidebar.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s) => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch])

/** Only schemes that mean "somewhere else" — never `javascript:`, never `data:`. */
const SAFE_HREF = /^(https?:|mailto:)/i

const ATX = /^(#{1,6})\s+(.*?)[ \t]*#*[ \t]*$/
const FENCE = /^[ \t]*(```+|~~~+)(.*)$/
const RULE = /^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const ITEM = /^([ \t]*)([-*+]|\d+[.)])[ \t]+(.*)$/
const QUOTE = /^[ \t]*>[ \t]?/
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/** The sentinel that parks a code span while emphasis is applied around it. */
const HOLD = '\u0000'

/**
 * Markdown to HTML.
 *
 * Block structure first, one pass down the lines; inline markup second, per block. That
 * split is what keeps a `#` inside a fence from becoming a heading and a `|` inside a
 * paragraph from becoming a table.
 */
export function renderMarkdown(src) {
  const lines = clean(src).split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    const fence = line.match(FENCE)
    if (fence) {
      const marker = fence[1][0]
      const lang = fence[2].trim().split(/\s+/)[0]
      const body = []
      i++
      while (i < lines.length && !new RegExp(`^[ \\t]*${marker}{${fence[1].length},}[ \\t]*$`).test(lines[i])) {
        body.push(lines[i++])
      }
      i++ // the closing fence, or the end of the file if it was never closed
      const cls = /^[\w+#.-]{1,20}$/.test(lang) ? ` class="lang-${escapeHtml(lang)}"` : ''
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const atx = line.match(ATX)
    if (atx) {
      const level = atx[1].length
      out.push(`<h${level}>${inline(atx[2])}</h${level}>`)
      i++
      continue
    }

    // Checked before the list, so `---` under nothing is a rule rather than a bullet.
    if (RULE.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const body = []
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && body.length))) {
        body.push(lines[i].replace(QUOTE, ''))
        i++
      }
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
      continue
    }

    // A table is only a table if the line under its header is the dashed rule; without that
    // check every paragraph mentioning a `|` becomes one.
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const rows = [line]
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++])
      out.push(table(rows))
      continue
    }

    if (ITEM.test(line)) {
      const block = []
      while (i < lines.length && (ITEM.test(lines[i]) || (lines[i].trim() && block.length && /^[ \t]/.test(lines[i])))) {
        block.push(lines[i++])
      }
      out.push(list(block))
      continue
    }

    // Everything else is a paragraph, running until a blank line or the start of a block.
    const para = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) para.push(lines[i++])

    // Setext headings: an underline of `=` or `-` promotes the paragraph above it. Reached
    // only here, because a `-` run that follows nothing was already claimed as a rule.
    if (i < lines.length && /^[ \t]*(=+|-+)[ \t]*$/.test(lines[i]) && para.length) {
      const level = lines[i].trim().startsWith('=') ? 1 : 2
      i++
      out.push(`<h${level}>${inline(para.join(' '))}</h${level}>`)
      continue
    }
    // A paragraph that was nothing but badges is nothing at all once the images are gone,
    // and an empty `<p>` still takes a paragraph's worth of space.
    const html = para.length ? inline(para.join('\n')) : ''
    if (html.trim()) out.push(`<p>${html}</p>`)
  }

  return out.join('')
}

/**
 * The two lines a repo leads with: what it is called, and what it is.
 *
 * This is what the sign at the gate carries and what the astronaut says when asked, so it
 * is plain text throughout — no markup survives, and a paragraph that turns out to be a row
 * of badges is skipped rather than shown as an empty quote.
 */
export function readmeSummary(src, fallbackTitle = '') {
  const lines = clean(src).split('\n')
  let title = ''
  let tagline = ''
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line.trim()) continue

    const atx = line.match(ATX)
    const setext = !atx && i + 1 < lines.length && /^[ \t]*=+[ \t]*$/.test(lines[i + 1])
    if (atx || setext) {
      const text = plain(atx ? atx[2] : line)
      // The first heading names the place; a later one has started the document proper, so
      // whatever the tagline was going to be, it is not under that.
      if (!title && text) title = text
      else if (title && !tagline) break
      if (setext) i++
      continue
    }
    if (RULE.test(line) || ITEM.test(line) || QUOTE.test(line) || line.includes('|')) continue

    const text = plain(line)
    if (!tagline && isSentence(text)) {
      tagline = text
      if (title) break
    }
  }

  return { title: title || fallbackTitle, tagline: tagline ? firstSentence(tagline, 220) : '' }
}

/**
 * One sentence out of an opening paragraph, falling back to a word-boundary cut.
 *
 * A tagline is read in two places that are both short of room — a card beside an astronaut
 * and a board on a post — and an opening paragraph that stops mid-clause reads as a bug.
 * A full stop is a much better place to end than any character count.
 */
function firstSentence(text, max) {
  const stop = text.search(/[.!?](\s|$)/)
  return stop > 30 && stop < max ? text.slice(0, stop + 1) : trim(text, max)
}

/**
 * Is this line actually *about* the project?
 *
 * The line under a title is very often a bare link, the remains of a badge row, or a
 * one-word status. None of them say what the place is, and all of them would otherwise end
 * up painted on the sign at its gate.
 */
function isSentence(text) {
  return text.length >= 18 && text.split(/\s+/).length >= 4 && !/^\S+$/.test(text)
}

/** Markdown down to the words in it — for a canvas sign, a tooltip, or a spoken line. */
export function plain(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?(?:a|abbr|b|big|blockquote|br|center|code|del|details|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|ol|p|picture|pre|s|small|source|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul|video|audio)\b[^<>]*>/gi, '')
    .replace(/`+/g, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cut to a length without cutting a word in half. */
export function trim(text, max) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`
}

// ── blocks ────────────────────────────────────────────────────────────────────────────

function clean(src) {
  return String(src || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '') // the inline pass parks code spans on this byte
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '') // YAML front matter, which docs tooling leaves behind
}

function isBlockStart(lines, i) {
  const line = lines[i]
  return (
    ATX.test(line) ||
    FENCE.test(line) ||
    RULE.test(line) ||
    ITEM.test(line) ||
    QUOTE.test(line) ||
    (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]))
  )
}

const cells = (row) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

function table(rows) {
  const head = cells(rows[0])
  const body = rows.slice(1).map(cells)
  const th = head.map((c) => `<th>${inline(c)}</th>`).join('')
  const tr = body
    .map((row) => `<tr>${head.map((_, k) => `<td>${inline(row[k] ?? '')}</td>`).join('')}</tr>`)
    .join('')
  // Wrapped, because a six-column table in a 320px sidebar has to scroll *itself* rather
  // than push the panel sideways.
  return `<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`
}

/**
 * A list, nested by indentation.
 *
 * Items are flattened first and re-nested after, because the depth of an item is only
 * knowable relative to the ones around it — a four-space bullet is a sub-item under a
 * flush one and a top-level item in a document that indents everything.
 */
function list(block) {
  const items = []
  for (const line of block) {
    const m = line.match(ITEM)
    if (m) items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: [m[3]] })
    else if (items.length) items[items.length - 1].text.push(line.trim())
  }
  if (!items.length) return ''

  let html = ''
  let i = 0
  while (i < items.length) {
    const [chunk, next] = build(items, i)
    html += chunk
    i = next
  }
  return html
}

function build(items, start) {
  const { indent, ordered } = items[start]
  const parts = []
  let i = start

  while (i < items.length) {
    const item = items[i]
    if (item.indent < indent) break
    if (item.indent > indent) {
      const [sub, next] = build(items, i)
      if (parts.length) parts[parts.length - 1] += sub
      else parts.push(sub)
      i = next
      continue
    }
    if (item.ordered !== ordered) break
    // GitHub's task lists: the box is the point of the line, so it is drawn rather than
    // rendered as the two literal brackets it is written with.
    const raw = item.text.join(' ').trim()
    const task = raw.match(/^\[([ xX])\]\s+(.*)$/)
    parts.push(
      task
        ? `<span class="md-task${task[1] === ' ' ? '' : ' done'}"></span>${inline(task[2])}`
        : inline(raw)
    )
    i++
  }

  const tag = ordered ? 'ol' : 'ul'
  return [`<${tag}>${parts.map((p) => `<li>${p}</li>`).join('')}</${tag}>`, i]
}

// ── inline ────────────────────────────────────────────────────────────────────────────

/**
 * Inline markup, in the one order that works: code spans are lifted out before anything
 * else can see them, everything left is escaped, and only then is markup put back — so a
 * `**` inside backticks stays two asterisks and a `<` anywhere at all stays a `<`.
 *
 * Only *known* HTML tags are stripped — the ones a README actually contains — because a
 * regex cannot tell a tag from a type: `Map<string, number>` and `Foo<T>` are shaped like
 * `<b>` and were losing their brackets to it. A bracket that is not one of those names is
 * prose, and prose is escaped and kept.
 */
function inline(text) {
  const codes = []
  let s = String(text)
    // `<https://…>` is a link, not a tag, and has to be recognised before tags are stripped.
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '[$1]($1)')
    .replace(/(`+)([^`]|[\s\S]*?[^`])\1(?!`)/g, (_, ticks, body) => {
      codes.push(body)
      return `${HOLD}${codes.length - 1}${HOLD}`
    })
    .replace(/<\/?(?:a|abbr|b|big|blockquote|br|center|code|del|details|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|ol|p|picture|pre|s|small|source|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul|video|audio)\b[^<>]*>/gi, '')

  s = escapeHtml(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // One level of balanced parentheses inside the URL, because Wikipedia links have them
    // and stopping at the first `)` turns `Foo_(bar)` into a broken link and a stray bracket.
    .replace(/\[([^\]]*)\]\(\s*((?:[^()\s]|\([^()\s]*\))*)(?:\s+[^)]*)?\)/g, (whole, label, href) => {
      const url = href.replace(/&amp;/g, '&')
      if (!SAFE_HREF.test(url)) return label || whole
      return `<a href="${escapeHtml(url).replace(/"/g, '%22')}" target="_blank" rel="noopener noreferrer">${label}</a>`
    })
    .replace(/~~([\s\S]+?)~~/g, '<del>$1</del>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\w\\])__([\s\S]+?)__(?![\w])/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*(?!\s)([\s\S]+?)(?<!\s)\*(?!\*)/g, '<em>$1</em>')
    // Underscores only between word boundaries, so `snake_case_names` survive intact.
    .replace(/(?<![\w_])_(?!\s)([^_]+?)(?<!\s)_(?![\w_])/g, '<em>$1</em>')
    .replace(/ {2,}\n/g, '<br>')
    .replace(/\n/g, ' ')

  return s.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_, n) => `<code>${escapeHtml(codes[Number(n)])}</code>`)
}
