import pako from 'pako'
import { describe, expect, it } from 'vitest'

import { InternalError } from '../../src/errors/InternalError.js'
import { GitObject } from '../../src/models/GitObject.js'
import { GitPackIndex } from '../../src/models/GitPackIndex.js'
import { shasum } from '../../src/utils/shasum.js'

function encodePackObjectHeader(type, length) {
  const bytes = []
  let byte = (type << 4) | (length & 0b1111)
  length = Math.floor(length / 16)
  if (length > 0) byte |= 0b10000000
  bytes.push(byte)

  while (length > 0) {
    byte = length & 0b01111111
    length = Math.floor(length / 128)
    if (length > 0) byte |= 0b10000000
    bytes.push(byte)
  }

  return Buffer.from(bytes)
}

function packObject(type, object, reference) {
  const header = encodePackObjectHeader(type, object.length)
  const base = type === 7 ? Buffer.from(reference, 'hex') : Buffer.alloc(0)
  return Buffer.concat([header, base, Buffer.from(pako.deflate(object))])
}

async function packfile(entries, declaredObjectCount = entries.length) {
  const header = Buffer.alloc(12)
  header.write('PACK', 0, 'ascii')
  header.writeUInt32BE(2, 4)
  header.writeUInt32BE(declaredObjectCount, 8)
  const body = Buffer.concat([header, ...entries])
  return Buffer.concat([body, Buffer.from(await shasum(body), 'hex')])
}

function encodeSize(size) {
  const bytes = []
  do {
    let byte = size & 0b01111111
    size = Math.floor(size / 128)
    if (size > 0) byte |= 0b10000000
    bytes.push(byte)
  } while (size > 0)
  return Buffer.from(bytes)
}

function insertDelta(sourceSize, target) {
  const instruction = target.length
    ? Buffer.concat([Buffer.from([target.length]), target])
    : Buffer.alloc(0)
  return Buffer.concat([
    encodeSize(sourceSize),
    encodeSize(target.length),
    instruction,
  ])
}

function copyAndAppendDelta(sourceSize, suffix) {
  const targetSize = sourceSize + suffix.length
  const copy = Buffer.from([0b10010000, sourceSize])
  const insert = Buffer.concat([Buffer.from([suffix.length]), suffix])
  return Buffer.concat([
    encodeSize(sourceSize),
    encodeSize(targetSize),
    copy,
    insert,
  ])
}

async function objectOid(type, object) {
  return shasum(GitObject.wrap({ type, object }))
}

function expectInternalError(promise) {
  return expect(promise).rejects.toMatchObject({ code: InternalError.code })
}

describe('Git pack validation (Workers environment)', () => {
  it('rejects a pack without its full checksum trailer', async () => {
    const header = Buffer.alloc(12)
    header.write('PACK', 0, 'ascii')
    header.writeUInt32BE(2, 4)

    await expectInternalError(GitPackIndex.fromPack({ pack: header }))
  })

  it('rejects a pack whose checksum does not match the body', async () => {
    const object = Buffer.from('valid object')
    const pack = await packfile([packObject(3, object)])
    pack[pack.length - 1] ^= 1

    await expectInternalError(GitPackIndex.fromPack({ pack }))
  })

  it('rejects a truncated object deflate stream with a valid trailer', async () => {
    const entry = Buffer.concat([
      encodePackObjectHeader(3, 1),
      Buffer.from([0x78]),
    ])
    const pack = await packfile([entry])

    await expectInternalError(GitPackIndex.fromPack({ pack }))
  })

  it('rejects an object count that exceeds the parsed pack body', async () => {
    const pack = await packfile([packObject(3, Buffer.from('one'))], 2)

    await expectInternalError(GitPackIndex.fromPack({ pack }))
  })

  it('rejects a reserved object type', async () => {
    const pack = await packfile([packObject(5, Buffer.from('invalid'))])

    await expectInternalError(GitPackIndex.fromPack({ pack }))
  })

  it('retries a REF_DELTA whose base object appears later in the pack', async () => {
    const base = Buffer.from('base object')
    const target = Buffer.from('target object')
    const baseOid = await objectOid('blob', base)
    const targetOid = await objectOid('blob', target)
    const pack = await packfile([
      packObject(7, insertDelta(base.length, target), baseOid),
      packObject(3, base),
    ])

    const index = await GitPackIndex.fromPack({ pack })
    const result = await index.read({ oid: targetOid })

    expect(result.type).toBe('blob')
    expect(result.object.equals(target)).toBe(true)
    expect(index.hashes).toEqual(expect.arrayContaining([baseOid, targetOid]))
  })

  it('rejects an unresolved REF_DELTA base after retrying the pack', async () => {
    const target = Buffer.from('target object')
    const missingBase = '11'.repeat(20)
    const pack = await packfile([
      packObject(7, insertDelta(4, target), missingBase),
    ])

    await expectInternalError(GitPackIndex.fromPack({ pack }))
  })

  it('preserves unexpected external REF_DELTA lookup failures', async () => {
    const target = Buffer.from('target object')
    const missingBase = '22'.repeat(20)
    const pack = await packfile([
      packObject(7, insertDelta(4, target), missingBase),
    ])
    const lookupError = new Error('external object store failed')

    await expect(
      GitPackIndex.fromPack({
        pack,
        getExternalRefDelta: async () => {
          throw lookupError
        },
      })
    ).rejects.toBe(lookupError)
  })

  it('limits actual inflated bytes even when the pack header understates them', async () => {
    const entry = Buffer.concat([
      encodePackObjectHeader(3, 1),
      Buffer.from(pako.deflate(Buffer.from('two'))),
    ])
    const pack = await packfile([entry])

    await expectInternalError(
      GitPackIndex.fromPack({
        pack,
        maxObjectBytes: 1,
        maxTotalObjectBytes: 32,
      })
    )
  })

  it('limits reconstructed delta targets before allocation', async () => {
    const base = Buffer.alloc(100, 0x61)
    const maxObjectBytes = base.length
    const baseOid = await objectOid('blob', base)
    const pack = await packfile([
      packObject(3, base),
      packObject(7, copyAndAppendDelta(base.length, Buffer.from('b')), baseOid),
    ])

    await expect(
      GitPackIndex.fromPack({
        pack,
        maxObjectBytes,
        maxTotalObjectBytes: 512,
      })
    ).rejects.toMatchObject({
      code: InternalError.code,
      data: {
        message: expect.stringContaining(
          `configured ${maxObjectBytes}-byte limit`
        ),
      },
    })
  })

  it('applies the aggregate budget to inflated and materialized objects', async () => {
    const pack = await packfile([packObject(3, Buffer.from('abc'))])

    await expect(
      GitPackIndex.fromPack({
        pack,
        maxObjectBytes: 3,
        maxTotalObjectBytes: 5,
      })
    ).rejects.toMatchObject({
      code: InternalError.code,
      data: {
        message: expect.stringContaining('configured 5-byte object budget'),
      },
    })
  })

  it('caps delta targets at the remaining aggregate budget before allocation', async () => {
    const base = Buffer.alloc(100, 0x61)
    const baseOid = await objectOid('blob', base)
    const delta = copyAndAppendDelta(base.length, Buffer.from('b'))
    const pack = await packfile([
      packObject(3, base),
      packObject(7, delta, baseOid),
    ])

    await expect(
      GitPackIndex.fromPack({
        pack,
        maxObjectBytes: 200,
        maxTotalObjectBytes: 250,
      })
    ).rejects.toMatchObject({
      code: InternalError.code,
      data: {
        message: expect.stringContaining('configured 44-byte object budget'),
      },
    })
  })

  it('indexes and reads a valid pack', async () => {
    const object = Buffer.from('small valid blob')
    const oid = await objectOid('blob', object)
    const pack = await packfile([packObject(3, object)])

    const index = await GitPackIndex.fromPack({ pack })
    const result = await index.read({ oid })

    expect(index.hashes).toEqual([oid])
    expect(index.packfileSha).toBe(await shasum(pack.slice(0, -20)))
    expect(result.type).toBe('blob')
    expect(result.object.equals(object)).toBe(true)
  })

  it('does not charge a materialized delta twice when it is read again', async () => {
    const base = Buffer.alloc(10, 0x61)
    const target = Buffer.concat([base, Buffer.from('b')])
    const baseOid = await objectOid('blob', base)
    const targetOid = await objectOid('blob', target)
    const delta = copyAndAppendDelta(base.length, Buffer.from('b'))
    const pack = await packfile([
      packObject(3, base),
      packObject(7, delta, baseOid),
    ])

    const maxTotalObjectBytes =
      base.length + delta.length + base.length + target.length

    const index = await GitPackIndex.fromPack({
      pack,
      maxObjectBytes: 16,
      maxTotalObjectBytes,
    })
    const result = await index.read({ oid: targetOid })

    expect(result.object.equals(target)).toBe(true)
  })
})
