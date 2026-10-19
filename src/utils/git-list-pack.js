// My version of git-list-pack - roughly 15x faster than the original
// It's used slightly differently - instead of returning a through stream it wraps a stream.
// (I tried to make it API identical, but that ended up being 2x slower than this version.)
import pako from 'pako'

import { InternalError } from '../errors/InternalError.js'
import { StreamReader } from '../utils/StreamReader.js'

export async function listpack(stream, onData, budget = {}) {
  const maxObjectBytes = budget.maxObjectBytes ?? Number.MAX_SAFE_INTEGER
  const maxTotalObjectBytes =
    budget.maxTotalObjectBytes ?? Number.MAX_SAFE_INTEGER
  const reader = new StreamReader(stream)
  let PACK = await reader.read(4)
  PACK = PACK.toString('utf8')
  if (PACK !== 'PACK') {
    throw new InternalError(`Invalid PACK header '${PACK}'`)
  }

  let version = await reader.read(4)
  version = version.readUInt32BE(0)
  if (version !== 2) {
    throw new InternalError(`Invalid packfile version: ${version}`)
  }

  let numObjects = await reader.read(4)
  numObjects = numObjects.readUInt32BE(0)
  const declaredObjectCount = numObjects
  let declaredObjectBytes = budget.used ?? 0
  let parsedObjectCount = 0

  while (parsedObjectCount < declaredObjectCount) {
    if (reader.eof()) {
      throw new InternalError(
        `Packfile ended after ${parsedObjectCount} of ${declaredObjectCount} declared objects`
      )
    }
    const offset = reader.tell()
    const { type, length, ofs, reference } = await parseHeader(reader)

    if (![1, 2, 3, 4, 6, 7].includes(type)) {
      throw new InternalError(`Unsupported pack object type: ${type}`)
    }
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maxObjectBytes
    ) {
      throw new InternalError(
        `Pack object exceeds configured ${maxObjectBytes}-byte limit`
      )
    }
    declaredObjectBytes += length
    if (
      !Number.isSafeInteger(declaredObjectBytes) ||
      declaredObjectBytes > maxTotalObjectBytes
    ) {
      throw new InternalError(
        `Pack exceeds configured ${maxTotalObjectBytes}-byte object budget`
      )
    }
    budget.used = declaredObjectBytes

    let inflatedBytes = 0
    const inflatedChunks = []
    const inflator = new pako.Inflate({
      chunkSize: Math.max(
        1,
        Math.min(64 * 1024, maxObjectBytes || 1, length || 1)
      ),
    })
    inflator.onData = chunk => {
      inflatedBytes += chunk.byteLength
      if (inflatedBytes > maxObjectBytes) {
        throw new InternalError(
          `Pack object exceeds configured ${maxObjectBytes}-byte limit`
        )
      }
      if (inflatedBytes > length) {
        throw new InternalError(
          'Inflated object size is different from that stated in packfile.'
        )
      }
      inflatedChunks.push(chunk)
    }

    while (!inflator.ended) {
      const chunk = await reader.chunk()
      if (!chunk) break
      inflator.push(chunk, false)
      if (inflator.err) {
        throw new InternalError(`Pako error: ${inflator.msg}`)
      }
      if (inflator.ended) {
        const data = Buffer.concat(inflatedChunks, inflatedBytes)
        if (data.length !== length) {
          throw new InternalError(
            `Inflated object size is different from that stated in packfile.`
          )
        }

        // Backtrack parser to where deflated data ends
        const consumedBytes = chunk.length - inflator.strm.avail_in
        if (consumedBytes < 0 || consumedBytes > chunk.length) {
          throw new InternalError(
            'Invalid compressed object length in packfile'
          )
        }
        await reader.undo()
        await reader.read(consumedBytes)
        const end = reader.tell()
        await onData({
          data,
          type,
          num: declaredObjectCount - parsedObjectCount,
          offset,
          end,
          reference,
          ofs,
        })
      }
    }
    if (!inflator.ended) {
      throw new InternalError(
        'Pack object ended before its deflate stream completed'
      )
    }
    parsedObjectCount++
  }

  return { objectCount: parsedObjectCount, endOffset: reader.tell() }
}

async function parseHeader(reader) {
  // Object type is encoded in bits 654
  let byte = await reader.byte()
  if (byte === undefined) {
    throw new InternalError('Packfile ended while reading an object header')
  }
  const type = (byte >> 4) & 0b111
  // The length encoding get complicated.
  // Last four bits of length is encoded in bits 3210
  let length = byte & 0b1111
  // Whether the next byte is part of the variable-length encoded number
  // is encoded in bit 7
  if (byte & 0b10000000) {
    let shift = 4
    do {
      byte = await reader.byte()
      if (byte === undefined) {
        throw new InternalError('Packfile ended while reading an object length')
      }
      length += (byte & 0b01111111) * 2 ** shift
      if (!Number.isSafeInteger(length)) {
        throw new InternalError(
          'Pack object length exceeds the safe integer range'
        )
      }
      if (byte & 0b10000000) shift += 7
    } while (byte & 0b10000000)
  }
  // Handle deltified objects
  let ofs
  let reference
  if (type === 6) {
    let shift = 0
    ofs = 0
    const bytes = []
    do {
      byte = await reader.byte()
      if (byte === undefined) {
        throw new InternalError(
          'Packfile ended while reading an ofs-delta base'
        )
      }
      ofs += (byte & 0b01111111) * 2 ** shift
      if (!Number.isSafeInteger(ofs)) {
        throw new InternalError(
          'Pack ofs-delta base exceeds the safe integer range'
        )
      }
      if (byte & 0b10000000) shift += 7
      bytes.push(byte)
    } while (byte & 0b10000000)
    reference = Buffer.from(bytes)
  }
  if (type === 7) {
    const buf = await reader.read(20)
    if (!buf || buf.length !== 20) {
      throw new InternalError('Packfile ended while reading a ref-delta base')
    }
    reference = buf
  }
  return { type, length, ofs, reference }
}
