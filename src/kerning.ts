/**
 * Pair kerning read straight from a font's GPOS table.
 *
 * opentype.js can't read kerning stored in "extension" lookups (lookup type 9), which is how most
 * modern fonts ship it (GT Ultra, ABC Arizona, Source Serif…), so it reports no kerning at all.
 * This reads the `kern` feature's pair-adjustment lookups (type 2, plain or inside type 9) for the
 * horizontal advance adjustment of the first glyph. Variation deltas aren't applied: variable fonts
 * get their default kerning.
 */
export type PairKerning = (left: number, right: number) => number

export function readPairKerning(data: ArrayBuffer): PairKerning | null {
  try {
    const view = new DataView(data)
    const u16 = (o: number) => view.getUint16(o)
    const i16 = (o: number) => view.getInt16(o)
    const u32 = (o: number) => view.getUint32(o)

    // table directory (plain TrueType / OpenType only; WOFF is compressed and falls back)
    const version = u32(0)
    if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) return null
    let gpos = -1
    for (let i = 0, n = u16(4); i < n; i++) {
      const rec = 12 + i * 16
      if (u32(rec) === 0x47504f53) gpos = u32(rec + 8) // 'GPOS'
    }
    if (gpos < 0) return null

    const featureList = gpos + u16(gpos + 6)
    const lookupList = gpos + u16(gpos + 8)
    const kernLookups = new Set<number>()
    for (let i = 0, n = u16(featureList); i < n; i++) {
      const rec = featureList + 2 + i * 6
      if (u32(rec) !== 0x6b65726e) continue // 'kern'
      const feature = featureList + u16(rec + 4)
      for (let j = 0, m = u16(feature + 2); j < m; j++) kernLookups.add(u16(feature + 4 + j * 2))
    }

    // every pair-adjustment subtable of those lookups, in lookup order
    const subtables: number[][] = []
    for (const index of [...kernLookups].sort((a, b) => a - b)) {
      const lookup = lookupList + u16(lookupList + 2 + index * 2)
      const type = u16(lookup)
      const list: number[] = []
      for (let j = 0, m = u16(lookup + 4); j < m; j++) {
        let sub = lookup + u16(lookup + 6 + j * 2)
        let subType = type
        if (type === 9) {
          subType = u16(sub + 2)
          sub = sub + u32(sub + 4)
        }
        if (subType === 2) list.push(sub)
      }
      subtables.push(list)
    }

    const valueSize = (format: number) => {
      let n = 0
      for (let bit = format; bit; bit >>= 1) n += bit & 1
      return n * 2
    }
    // offset of XAdvance inside a value record, or -1 if the record has none
    const xAdvanceAt = (format: number) => {
      if (!(format & 0x4)) return -1
      return ((format & 0x1 ? 1 : 0) + (format & 0x2 ? 1 : 0)) * 2
    }
    const coverageIndex = (table: number, glyph: number) => {
      const format = u16(table)
      if (format === 1) {
        let lo = 0
        let hi = u16(table + 2) - 1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          const g = u16(table + 4 + mid * 2)
          if (g === glyph) return mid
          if (g < glyph) lo = mid + 1
          else hi = mid - 1
        }
        return -1
      }
      if (format === 2) {
        for (let i = 0, n = u16(table + 2); i < n; i++) {
          const r = table + 4 + i * 6
          if (glyph >= u16(r) && glyph <= u16(r + 2)) return u16(r + 4) + glyph - u16(r)
        }
      }
      return -1
    }
    const classOf = (table: number, glyph: number) => {
      const format = u16(table)
      if (format === 1) {
        const start = u16(table + 2)
        const count = u16(table + 4)
        return glyph >= start && glyph < start + count ? u16(table + 6 + (glyph - start) * 2) : 0
      }
      if (format === 2) {
        for (let i = 0, n = u16(table + 2); i < n; i++) {
          const r = table + 4 + i * 6
          if (glyph >= u16(r) && glyph <= u16(r + 2)) return u16(r + 4)
        }
      }
      return 0
    }

    // the first subtable of a lookup that covers the pair decides; lookups add up
    const pairInLookup = (list: number[], left: number, right: number) => {
      for (const sub of list) {
        const format = u16(sub)
        const covered = coverageIndex(sub + u16(sub + 2), left)
        if (covered < 0) continue
        const vf1 = u16(sub + 4)
        const vf2 = u16(sub + 6)
        const at = xAdvanceAt(vf1)
        if (format === 1) {
          const set = sub + u16(sub + 10 + covered * 2)
          const record = 2 + valueSize(vf1) + valueSize(vf2)
          let lo = 0
          let hi = u16(set) - 1
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            const r = set + 2 + mid * record
            const g = u16(r)
            if (g === right) return at < 0 ? 0 : i16(r + 2 + at)
            if (g < right) lo = mid + 1
            else hi = mid - 1
          }
          continue // this pair isn't in the list; a later subtable may have it
        }
        if (format === 2) {
          const c1 = classOf(sub + u16(sub + 8), left)
          const c2 = classOf(sub + u16(sub + 10), right)
          const class2Count = u16(sub + 14)
          const record = valueSize(vf1) + valueSize(vf2)
          const r = sub + 16 + (c1 * class2Count + c2) * record
          return at < 0 ? 0 : i16(r + at)
        }
      }
      return 0
    }

    const cache = new Map<number, number>()
    return (left, right) => {
      const key = left * 65536 + right
      let v = cache.get(key)
      if (v === undefined) {
        v = 0
        for (const list of subtables) v += pairInLookup(list, left, right)
        cache.set(key, v)
      }
      return v
    }
  } catch {
    return null
  }
}
