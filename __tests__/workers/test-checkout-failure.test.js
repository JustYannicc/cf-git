import { describe, expect, it } from 'vitest'

import {
  checkout,
  init,
  writeBlob,
  writeCommit,
  writeRef,
  writeTree,
} from '../../src/index.js'

import { createMemoryFs } from './helpers/memory-fs.js'

function deferred() {
  let complete
  const promise = new Promise(resolve => {
    complete = resolve
  })
  return { promise, resolve: complete }
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

async function makeCheckoutRepository() {
  const memory = createMemoryFs()
  const { fs } = memory
  const dir = '/checkout'
  const author = {
    name: 'Worker test',
    email: 'worker-test@example.test',
    timestamp: 1700000000,
    timezoneOffset: 0,
  }

  await init({ fs, dir, defaultBranch: 'main' })
  const oldBlob = await writeBlob({ fs, dir, blob: Buffer.from('old file\n') })
  const baseTree = await writeTree({
    fs,
    dir,
    tree: [
      { mode: '100644', path: 'obsolete.txt', oid: oldBlob, type: 'blob' },
    ],
  })
  const baseCommit = await writeCommit({
    fs,
    dir,
    commit: {
      tree: baseTree,
      parent: [],
      author,
      committer: author,
      message: 'Base commit\n',
    },
  })
  const badBlob = await writeBlob({
    fs,
    dir,
    blob: Buffer.from('failed write\n'),
  })
  const slowBlob = await writeBlob({
    fs,
    dir,
    blob: Buffer.from('pending write\n'),
  })
  const targetTree = await writeTree({
    fs,
    dir,
    tree: [
      { mode: '100644', path: 'bad.txt', oid: badBlob, type: 'blob' },
      { mode: '100644', path: 'slow.txt', oid: slowBlob, type: 'blob' },
    ],
  })
  const targetCommit = await writeCommit({
    fs,
    dir,
    commit: {
      tree: targetTree,
      parent: [baseCommit],
      author,
      committer: author,
      message: 'Target commit\n',
    },
  })

  await writeRef({ fs, dir, ref: 'refs/heads/main', value: baseCommit })
  await writeRef({ fs, dir, ref: 'refs/heads/next', value: targetCommit })
  await checkout({ fs, dir, ref: 'main' })

  return { ...memory, dir, fs, baseCommit, targetCommit }
}

describe.each([false, true])(
  'checkout write failures with nonBlocking=%s',
  nonBlocking => {
    it('rejects after pending writes settle and leaves HEAD and index unchanged', async () => {
      const repository = await makeCheckoutRepository()
      const headPath = `${repository.dir}/.git/HEAD`
      const indexPath = `${repository.dir}/.git/index`
      const headBefore = repository.getFile(headPath)
      const indexBefore = repository.getFile(indexPath)
      const failure = new Error('forced in-memory write failure')
      const failureRetryStarted = deferred()
      const slowWriteStarted = deferred()
      const releaseSlowWrite = deferred()
      let failingAttempts = 0
      let slowWritePending = true
      let returnedBeforeSlowWriteFinished = false

      repository.setWriteHook(async filepath => {
        if (filepath === `${repository.dir}/bad.txt`) {
          failingAttempts++
          if (failingAttempts === 2) failureRetryStarted.resolve()
          throw failure
        }
        if (filepath === `${repository.dir}/slow.txt`) {
          slowWriteStarted.resolve()
          await releaseSlowWrite.promise
        }
      })

      const checkoutResult = checkout({
        fs: repository.fs,
        dir: repository.dir,
        ref: 'next',
        nonBlocking,
        batchSize: 2,
      }).then(
        () => {
          returnedBeforeSlowWriteFinished =
            returnedBeforeSlowWriteFinished || slowWritePending
          return { status: 'fulfilled' }
        },
        error => {
          returnedBeforeSlowWriteFinished =
            returnedBeforeSlowWriteFinished || slowWritePending
          return { status: 'rejected', error }
        }
      )

      await Promise.all([failureRetryStarted.promise, slowWriteStarted.promise])
      await flushMicrotasks()
      const hadReturnedBeforePendingWrite = returnedBeforeSlowWriteFinished
      slowWritePending = false
      releaseSlowWrite.resolve()

      const result = await checkoutResult

      expect(hadReturnedBeforePendingWrite).toBe(false)
      expect(result.status).toBe('rejected')
      expect(result.error.message).toBe(failure.message)
      expect(repository.getFile(headPath)).toEqual(headBefore)
      expect(repository.getFile(indexPath)).toEqual(indexBefore)
    })

    it('updates the worktree, HEAD, and index when all writes succeed', async () => {
      const repository = await makeCheckoutRepository()

      await checkout({
        fs: repository.fs,
        dir: repository.dir,
        ref: 'next',
        nonBlocking,
        batchSize: 2,
      })

      expect(repository.getFile(`${repository.dir}/bad.txt`).toString()).toBe(
        'failed write\n'
      )
      expect(repository.getFile(`${repository.dir}/slow.txt`).toString()).toBe(
        'pending write\n'
      )
      expect(
        repository.getFile(`${repository.dir}/.git/HEAD`).toString('utf8')
      ).toBe('ref: refs/heads/next\n')
      expect(repository.getFile(`${repository.dir}/.git/index`)).not.toBeNull()
      expect(repository.getFile(`${repository.dir}/obsolete.txt`)).toBeNull()
    })
  }
)
