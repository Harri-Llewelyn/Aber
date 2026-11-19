/*!
 * An AASX package is unpacked with `fflate` (https://github.com/101arrowz/fflate), whose notice
 * follows. NOTICE.md names it.
 *
 * MIT License
 *
 * Copyright (c) 2026 Arjun Barrett
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { Unzip, Inflate } from 'fflate'

/*
 * Reads the parts of an AASX package (IDTA 01005, which is an Open Packaging Conventions zip) that
 * hold an Asset Administration Shell environment. The package comes from outside, so every limit is
 * counted while the bytes are inflated, never taken from the sizes the zip declares.
 */

const MiB = 1024 * 1024

/** What a package may hold. A file over `maxFileBytes` is refused before it is opened (aasReader.js). */
export const PACKAGE_LIMITS = Object.freeze({
  maxFileBytes: 25 * MiB,
  maxEntries: 5000,
  maxEntryBytes: 50 * MiB,
  maxTotalBytes: 100 * MiB,
  /** An entry may not inflate to more than this many times the bytes it was packed in. */
  maxRatio: 100,
  /** The ratio is judged once an entry has inflated this far: a few bytes of header skew it below. */
  ratioFromBytes: 1 * MiB
})

/** The package root's relationships, and the three relationship types the reader follows (IDTA 01005). */
const ROOT_RELS = '_rels/.rels'
const ORIGIN_TYPE = '/aasx/relationships/aasx-origin'
const SPEC_TYPE = '/aasx/relationships/aas-spec'

/** A refusal of the file, with the sentence the dialog shows. */
export class AasFileRefusal extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'AasFileRefusal'
    this.reason = reason
  }
}

/** The compressed bytes are pushed in slices this size, so a bomb is stopped within a slice of it. */
const SLICE_BYTES = 8 * 1024

const mb = (bytes) => `${Math.round(bytes / MiB)} MB`

/** An entry name as the dialog shows it: short, with nothing a reader cannot see. */
function printable(name) {
  // eslint-disable-next-line no-control-regex
  const clean = String(name).replace(/[\u0000-\u001f\u007f]/g, '?')
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean
}

/** Why an entry's name is refused, or null. Absolute paths, `..`, backslashes and drive letters. */
export function entryNameProblem(name) {
  if (typeof name !== 'string' || name === '') return 'it has no name'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'its name holds a control character'
  if (name.includes('\\')) return 'its name holds a backslash'
  if (name.startsWith('/')) return 'its name is an absolute path'
  if (/^[A-Za-z]:/.test(name)) return 'its name starts with a drive letter'
  if (name.split('/').includes('..')) return 'its name holds a `..` segment'
  return null
}

/** Whether a part's bytes are kept: the relationships, and anything that could be an environment. */
const isWanted = (name) => /\.(rels|json|xml)$/i.test(name)

/** The chunks of one part as one array. */
function joined(chunks, size) {
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
  return out
}

/**
 * Inflate every entry of a zip, counting the bytes as they come out. Returns the parts worth reading,
 * `Map<name, Uint8Array>`, or throws an AasFileRefusal naming the rule that stopped it. `L` is the
 * limits, which only a test changes.
 */
export function unpackPackage(bytes, L = PACKAGE_LIMITS) {
  const state = { entries: 0, total: 0, refusal: null, names: new Set(), parts: new Map() }
  const refuse = (reason) => { state.refusal ??= reason }

  /** Counts the bytes of one entry; returns false once a rule has stopped the unpacking. */
  const account = (name, packed, entry) => {
    if (state.refusal) return false
    if (entry > L.maxEntryBytes) {
      refuse(`The package entry “${printable(name)}” expands past ${mb(L.maxEntryBytes)}, which is more than a package may hold in one entry.`)
    } else if (state.total > L.maxTotalBytes) {
      refuse(`The package expands past ${mb(L.maxTotalBytes)}, which is more than a package may hold in all.`)
    } else if (entry > L.ratioFromBytes && entry > L.maxRatio * Math.max(packed, 1)) {
      refuse(`The package entry “${printable(name)}” expands to more than ${L.maxRatio} times its packed size, which is how a zip bomb is built.`)
    }
    return !state.refusal
  }

  /** A decoder for one compression method; the same accounting serves stored and deflated entries. */
  const decoderFor = (compression, inflates) => class {
    static compression = compression

    constructor(name) {
      this.name = name
      this.packed = 0
      this.unpacked = 0
      this.inflate = inflates
        ? new Inflate((chunk, final) => this.emit(chunk, final))
        : null
    }

    emit(chunk, final) {
      this.unpacked += chunk.length
      state.total += chunk.length
      if (account(this.name, this.packed, this.unpacked)) this.ondata(null, chunk, final)
    }

    push(chunk, final) {
      if (state.refusal) return
      this.packed += chunk.length
      if (!this.inflate) return this.emit(chunk, final)
      try {
        this.inflate.push(chunk, final)
      } catch (e) {
        this.ondata(e, null, final)
      }
    }
  }

  const unzip = new Unzip((file) => {
    if (state.refusal) return
    state.entries += 1
    const name = file.name
    if (state.entries > L.maxEntries) {
      return refuse(`The package holds more than ${L.maxEntries.toLocaleString('en-GB')} entries, which is more than a package may hold.`)
    }
    const problem = entryNameProblem(name)
    if (problem) return refuse(`The package has an entry named “${printable(name)}” and ${problem}, which a package may not have.`)
    if (state.names.has(name)) return refuse(`The package holds two entries named “${printable(name)}”.`)
    state.names.add(name)

    const keep = isWanted(name)
    const chunks = []
    let size = 0
    file.ondata = (error, data, final) => {
      if (state.refusal) return
      if (error) {
        return refuse(`The package entry “${printable(name)}” cannot be unpacked (${error.message || error}).`)
      }
      if (keep && data?.length) {
        // The inflater reuses its buffer: a part keeps its own copy.
        chunks.push(data.slice())
        size += data.length
      }
      if (final && keep) state.parts.set(name, joined(chunks, size))
    }
    file.start()
  })
  unzip.register(decoderFor(0, false))
  unzip.register(decoderFor(8, true))

  try {
    for (let at = 0; at < bytes.length && !state.refusal; at += SLICE_BYTES) {
      unzip.push(bytes.subarray(at, Math.min(bytes.length, at + SLICE_BYTES)), at + SLICE_BYTES >= bytes.length)
    }
    if (bytes.length === 0) unzip.push(new Uint8Array(0), true)
  } catch (e) {
    if (!state.refusal) {
      throw new AasFileRefusal(`The file is not a readable zip package (${e.message || e}).`)
    }
  }
  if (state.refusal) throw new AasFileRefusal(state.refusal)
  if (state.entries === 0) throw new AasFileRefusal('The file is a zip with no entries, so it holds no package.')
  return state.parts
}

/** The relationships a `.rels` part states: `[{ type, target }]`. Reads the XML as the reader does. */
function relationshipsOf(parseXml, bytes) {
  const doc = parseXml(new TextDecoder().decode(bytes))
  return [...doc.getElementsByTagName('Relationship')].map((el) => ({
    type: el.getAttribute('Type') || '',
    target: el.getAttribute('Target') || ''
  }))
}

/** A relationship type, ignoring the `www.` the first AAS release put in its host. */
const hasType = (relationship, tail) => relationship.type.replace('://www.', '://').endsWith(`http://admin-shell.io${tail}`)

/** The part a relationship's target names, from a part in `base` (a folder, with no leading slash). */
export function resolveTarget(target, base) {
  let path
  try { path = decodeURIComponent(target) } catch { path = target }
  const parts = path.startsWith('/') ? [] : base.split('/').filter(Boolean)
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    parts.push(segment)
  }
  return parts.join('/')
}

const folderOf = (name) => name.slice(0, name.lastIndexOf('/') + 1).replace(/\/$/, '')
const relsOf = (name) => `${folderOf(name)}${folderOf(name) ? '/' : ''}_rels/${name.slice(name.lastIndexOf('/') + 1)}.rels`

/**
 * The environment parts of an AASX package: the parts the origin's `aas-spec` relationships name
 * (IDTA 01005), as `[{ name, bytes }]`. A package with no such relationship is refused, and the
 * reason says which link is missing.
 *
 * @param {Uint8Array} bytes the whole package
 * @param {(text: string) => Document} parseXml the reader's XML parser, which refuses a DOCTYPE
 */
export function readAasxPackage(bytes, parseXml) {
  const parts = unpackPackage(bytes)

  const root = parts.get(ROOT_RELS)
  if (!root) {
    throw new AasFileRefusal('The package has no `_rels/.rels`, so it is not an AASX package (IDTA 01005): there is no relationship to follow from its root.')
  }
  const origin = relationshipsOf(parseXml, root).find((r) => hasType(r, ORIGIN_TYPE))
  if (!origin) {
    throw new AasFileRefusal('The package root has no `aasx-origin` relationship, so it is not an AASX package (IDTA 01005).')
  }
  const originName = resolveTarget(origin.target, '')
  if (!originName) throw new AasFileRefusal('The package names its origin part with a `..` segment, which a package may not.')

  const originRels = parts.get(relsOf(originName))
  const specs = originRels ? relationshipsOf(parseXml, originRels).filter((r) => hasType(r, SPEC_TYPE)) : []
  if (specs.length === 0) {
    throw new AasFileRefusal(`The package's origin part (/${originName}) has no \`aas-spec\` relationship, so it names no Asset Administration Shell to read (IDTA 01005).`)
  }

  const found = []
  for (const spec of specs) {
    const name = resolveTarget(spec.target, folderOf(originName))
    if (!name) throw new AasFileRefusal('The package names an `aas-spec` part with a `..` segment, which a package may not.')
    const part = parts.get(name)
    if (!part) {
      throw new AasFileRefusal(`The package's \`aas-spec\` relationship names /${name}, which the package does not hold as a JSON or XML part.`)
    }
    found.push({ name, bytes: part })
  }
  return found
}
