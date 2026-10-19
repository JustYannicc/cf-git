/* eslint-env node, browser */
/* global DecompressionStream */
import pako from 'pako'

import { InternalError } from '../errors/InternalError.js'

let supportsDecompressionStream = false

export async function inflate(
  buffer,
  maxOutputBytes = Number.MAX_SAFE_INTEGER
) {
  if (maxOutputBytes < Number.MAX_SAFE_INTEGER) {
    let inflatedBytes = 0
    const inflatedChunks = []
    const inflator = new pako.Inflate({
      chunkSize: Math.max(1, Math.min(64 * 1024, maxOutputBytes || 1)),
    })
    inflator.onData = chunk => {
      inflatedBytes += chunk.byteLength
      if (inflatedBytes > maxOutputBytes) {
        throw new InternalError(
          `Pack object exceeds configured ${maxOutputBytes}-byte limit`
        )
      }
      inflatedChunks.push(chunk)
    }
    inflator.push(buffer, true)
    if (inflator.err) throw new InternalError(`Pako error: ${inflator.msg}`)
    if (!inflator.ended) {
      throw new InternalError(
        'Pack object ended before its deflate stream completed'
      )
    }
    return Buffer.concat(inflatedChunks, inflatedBytes)
  }
  if (supportsDecompressionStream === null) {
    supportsDecompressionStream = testDecompressionStream()
  }
  return supportsDecompressionStream
    ? browserInflate(buffer)
    : pako.inflate(buffer)
}

async function browserInflate(buffer) {
  const ds = new DecompressionStream('deflate')
  const d = new Blob([buffer]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(d).arrayBuffer())
}

function testDecompressionStream() {
  try {
    const ds = new DecompressionStream('deflate')
    if (ds) return true
  } catch (_) {
    // no bother
  }
  return false
}
