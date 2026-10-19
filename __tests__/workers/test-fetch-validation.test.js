/* global crypto */
import { beforeAll, describe, expect, it } from 'vitest'

import {
  addRemote,
  clone,
  fetch,
  init,
  packObjects,
  writeBlob,
  writeCommit,
  writeRef,
  writeTree,
} from '../../src/index.js'

import { createMemoryFs } from './helpers/memory-fs.js'

const remoteUrl = 'https://example.test/repo.git'
const oldRemoteOid = 'a'.repeat(40)
const oldShallowOid = 'b'.repeat(40)
const responseShallowOid = 'c'.repeat(40)

function pktLine(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const length = (data.length + 4).toString(16).padStart(4, '0')
  return Buffer.concat([Buffer.from(length), data])
}

async function sha1(buffer) {
  const digest = await crypto.subtle.digest('SHA-1', buffer)
  return Buffer.from(digest)
}

async function makeRemotePack() {
  const { fs } = createMemoryFs()
  const dir = '/remote'
  const content = Buffer.from('a small checked-out file\n')
  const author = {
    name: 'Worker test',
    email: 'worker-test@example.test',
    timestamp: 1700000000,
    timezoneOffset: 0,
  }

  await init({ fs, dir, defaultBranch: 'main' })
  const blobOid = await writeBlob({ fs, dir, blob: content })
  const treeOid = await writeTree({
    fs,
    dir,
    tree: [{ mode: '100644', path: 'README.md', oid: blobOid, type: 'blob' }],
  })
  const commitOid = await writeCommit({
    fs,
    dir,
    commit: {
      tree: treeOid,
      parent: [],
      author,
      committer: author,
      message: 'Worker fetch fixture\n',
    },
  })
  const { packfile } = await packObjects({
    fs,
    dir,
    oids: [commitOid, treeOid, blobOid],
  })

  return { commitOid, content, pack: Buffer.from(packfile) }
}

let remote

beforeAll(async () => {
  remote = await makeRemotePack()
})

function createSmartHttp(pack, { shallowOid } = {}) {
  const capabilities =
    'multi_ack_detailed side-band-64k shallow ofs-delta symref=HEAD:refs/heads/main'
  const advertisement = Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktLine(`${remote.commitOid} HEAD\0${capabilities}\n`),
    pktLine(`${remote.commitOid} refs/heads/main\n`),
    Buffer.from('0000'),
  ])
  const uploadPackResponse = Buffer.concat([
    ...(shallowOid ? [pktLine(`shallow ${shallowOid}\n`)] : []),
    pktLine('NAK\n'),
    pktLine(Buffer.concat([Buffer.from([1]), pack])),
    Buffer.from('0000'),
  ])

  return {
    async request({ method }) {
      return {
        statusCode: 200,
        headers:
          method === 'GET'
            ? {
                'content-type': 'application/x-git-upload-pack-advertisement',
              }
            : {},
        body: [method === 'GET' ? advertisement : uploadPackResponse],
      }
    },
  }
}

async function signPack(body) {
  return Buffer.concat([body, await sha1(body)])
}

const corruptions = [
  [
    'bad checksum',
    async pack => {
      const corrupted = Buffer.from(pack)
      corrupted[corrupted.length - 1] ^= 1
      return corrupted
    },
  ],
  [
    'incorrect object count',
    async pack => {
      const body = Buffer.from(pack.subarray(0, -20))
      body.writeUInt32BE(body.readUInt32BE(8) + 1, 8)
      return signPack(body)
    },
  ],
  [
    'truncated object data',
    async pack => {
      const body = Buffer.from(pack.subarray(0, -24))
      return signPack(body)
    },
  ],
]

async function makeFetchRepository() {
  const memory = createMemoryFs()
  const { fs } = memory
  const dir = '/local'

  await init({ fs, dir, defaultBranch: 'main' })
  await addRemote({ fs, dir, remote: 'origin', url: remoteUrl })
  await writeRef({
    fs,
    dir,
    ref: 'refs/remotes/origin/main',
    value: oldRemoteOid,
  })
  await fs.writeFile(`${dir}/.git/shallow`, `${oldShallowOid}\n`, 'utf8')

  return { ...memory, dir, fs }
}

function fetchArgs(repository, http, overrides = {}) {
  return {
    fs: repository.fs,
    http,
    dir: repository.dir,
    remote: 'origin',
    url: remoteUrl,
    ref: 'main',
    remoteRef: 'refs/heads/main',
    singleBranch: true,
    depth: 1,
    ...overrides,
  }
}

describe('public fetch and clone pack validation', () => {
  it.each(corruptions)(
    'rejects a %s before publishing refs, shallow state, or pack files',
    async (_name, corrupt) => {
      const repository = await makeFetchRepository()
      const invalidPack = await corrupt(remote.pack)

      await expect(
        fetch(
          fetchArgs(
            repository,
            createSmartHttp(invalidPack, {
              shallowOid: responseShallowOid,
            })
          )
        )
      ).rejects.toThrow()

      expect(
        repository
          .getFile(`${repository.dir}/.git/refs/remotes/origin/main`)
          .toString('utf8')
      ).toBe(`${oldRemoteOid}\n`)
      expect(
        repository.getFile(`${repository.dir}/.git/shallow`).toString('utf8')
      ).toBe(`${oldShallowOid}\n`)
      expect(
        repository
          .filePaths()
          .filter(filepath =>
            filepath.startsWith(`${repository.dir}/.git/objects/pack/`)
          )
      ).toEqual([])
    }
  )

  it.each([
    ['maxObjectBytes', { maxObjectBytes: 8, maxTotalObjectBytes: 1024 }],
    ['maxTotalObjectBytes', { maxObjectBytes: 1024, maxTotalObjectBytes: 8 }],
  ])('forwards %s through fetch', async (_name, limits) => {
    const repository = await makeFetchRepository()
    const http = createSmartHttp(remote.pack, {
      shallowOid: responseShallowOid,
    })

    await expect(fetch(fetchArgs(repository, http, limits))).rejects.toThrow()

    expect(
      repository
        .getFile(`${repository.dir}/.git/refs/remotes/origin/main`)
        .toString('utf8')
    ).toBe(`${oldRemoteOid}\n`)
    expect(
      repository.getFile(`${repository.dir}/.git/shallow`).toString('utf8')
    ).toBe(`${oldShallowOid}\n`)
    expect(
      repository
        .filePaths()
        .filter(filepath =>
          filepath.startsWith(`${repository.dir}/.git/objects/pack/`)
        )
    ).toEqual([])
  })

  it.each([
    ['maxObjectBytes', { maxObjectBytes: 8, maxTotalObjectBytes: 1024 }],
    ['maxTotalObjectBytes', { maxObjectBytes: 1024, maxTotalObjectBytes: 8 }],
  ])('forwards %s through clone', async (_name, limits) => {
    const repository = createMemoryFs()
    const http = createSmartHttp(remote.pack)

    await expect(
      clone({
        fs: repository.fs,
        http,
        dir: '/clone',
        url: remoteUrl,
        ref: 'main',
        ...limits,
      })
    ).rejects.toThrow()

    expect(repository.getFile('/clone/.git/config')).toBeNull()
  })

  it('fetches a valid pack and honors generous limits', async () => {
    const repository = await makeFetchRepository()
    const result = await fetch(
      fetchArgs(repository, createSmartHttp(remote.pack), {
        maxObjectBytes: 4096,
        maxTotalObjectBytes: 16384,
      })
    )

    expect(result.fetchHead).toBe(remote.commitOid)
    expect(
      repository
        .getFile(`${repository.dir}/.git/refs/remotes/origin/main`)
        .toString('utf8')
    ).toBe(`${remote.commitOid}\n`)
    expect(
      repository
        .filePaths()
        .filter(filepath =>
          filepath.startsWith(`${repository.dir}/.git/objects/pack/`)
        )
    ).toHaveLength(2)
  })

  it('clones a valid pack and checks out its file with generous limits', async () => {
    const repository = createMemoryFs()

    await clone({
      fs: repository.fs,
      http: createSmartHttp(remote.pack),
      dir: '/clone',
      url: remoteUrl,
      ref: 'main',
      maxObjectBytes: 4096,
      maxTotalObjectBytes: 16384,
    })

    expect(repository.getFile('/clone/README.md').toString()).toBe(
      remote.content.toString()
    )
    expect(
      repository
        .getFile('/clone/.git/refs/remotes/origin/main')
        .toString('utf8')
    ).toBe(`${remote.commitOid}\n`)
  })
})
