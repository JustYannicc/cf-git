function filesystemError(code, filepath) {
  const error = new Error(`${code}: ${filepath}`)
  error.code = code
  return error
}

function normalize(filepath) {
  const parts = []
  for (const part of filepath.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function parent(filepath) {
  const slash = filepath.lastIndexOf('/')
  return slash === 0 ? '/' : filepath.slice(0, slash)
}

function isInside(directory, filepath) {
  return filepath === directory || filepath.startsWith(`${directory}/`)
}

function makeStats({
  directory = false,
  symlink = false,
  contents = null,
  ino,
}) {
  const now = Date.now()
  const size = contents === null ? 0 : contents.length
  const mode = directory ? 0o040755 : symlink ? 0o120777 : 0o100644
  return {
    atime: new Date(now),
    atimeMs: now,
    birthtime: new Date(now),
    birthtimeMs: now,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    ctime: new Date(now),
    ctimeMs: now,
    dev: 1,
    gid: 1,
    ino,
    mode,
    mtime: new Date(now),
    mtimeMs: now,
    nlink: 1,
    size,
    uid: 1,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => directory,
    isFIFO: () => false,
    isFile: () => !directory && !symlink,
    isSocket: () => false,
    isSymbolicLink: () => symlink,
  }
}

export function createMemoryFs() {
  const files = new Map()
  const directories = new Set(['/'])
  const symlinks = new Map()
  const stats = new Map()
  let nextIno = 1
  let beforeWrite = null

  function lstatRecord(filepath) {
    filepath = normalize(filepath)
    if (!stats.has(filepath)) {
      if (files.has(filepath)) {
        stats.set(
          filepath,
          makeStats({ contents: files.get(filepath), ino: nextIno++ })
        )
      } else if (symlinks.has(filepath)) {
        stats.set(
          filepath,
          makeStats({
            symlink: true,
            contents: symlinks.get(filepath),
            ino: nextIno++,
          })
        )
      } else if (directories.has(filepath)) {
        stats.set(filepath, makeStats({ directory: true, ino: nextIno++ }))
      } else {
        throw filesystemError('ENOENT', filepath)
      }
    }
    return { ...stats.get(filepath) }
  }

  async function mkdir(filepath) {
    filepath = normalize(filepath)
    if (
      directories.has(filepath) ||
      files.has(filepath) ||
      symlinks.has(filepath)
    ) {
      throw filesystemError('EEXIST', filepath)
    }
    if (!directories.has(parent(filepath))) {
      throw filesystemError('ENOENT', parent(filepath))
    }
    directories.add(filepath)
    stats.delete(filepath)
  }

  async function writeFile(filepath, contents, options = {}) {
    filepath = normalize(filepath)
    if (!directories.has(parent(filepath))) {
      throw filesystemError('ENOENT', parent(filepath))
    }
    if (beforeWrite) await beforeWrite(filepath, contents)
    if (directories.has(filepath)) throw filesystemError('EISDIR', filepath)
    const encoding = typeof options === 'string' ? options : options.encoding
    files.set(
      filepath,
      typeof contents === 'string' && encoding
        ? Buffer.from(contents, encoding)
        : Buffer.from(contents)
    )
    symlinks.delete(filepath)
    stats.delete(filepath)
  }

  async function readFile(filepath, options = {}) {
    filepath = normalize(filepath)
    if (files.has(filepath)) {
      const contents = Buffer.from(files.get(filepath))
      const encoding = typeof options === 'string' ? options : options.encoding
      return encoding ? contents.toString(encoding) : contents
    }
    if (directories.has(filepath)) throw filesystemError('EISDIR', filepath)
    throw filesystemError('ENOENT', filepath)
  }

  async function unlink(filepath) {
    filepath = normalize(filepath)
    if (files.delete(filepath) || symlinks.delete(filepath)) {
      stats.delete(filepath)
      return
    }
    if (directories.has(filepath)) throw filesystemError('EISDIR', filepath)
    throw filesystemError('ENOENT', filepath)
  }

  async function rm(filepath, options = {}) {
    filepath = normalize(filepath)
    if (files.has(filepath) || symlinks.has(filepath)) {
      files.delete(filepath)
      symlinks.delete(filepath)
      stats.delete(filepath)
      return
    }
    if (!directories.has(filepath)) throw filesystemError('ENOENT', filepath)
    const children = [
      ...files.keys(),
      ...symlinks.keys(),
      ...directories,
    ].filter(
      candidate => candidate !== filepath && isInside(filepath, candidate)
    )
    if (children.length && !options.recursive)
      throw filesystemError('ENOTEMPTY', filepath)
    for (const candidate of children) {
      files.delete(candidate)
      symlinks.delete(candidate)
      directories.delete(candidate)
      stats.delete(candidate)
    }
    if (filepath !== '/') directories.delete(filepath)
    stats.delete(filepath)
  }

  async function rmdir(filepath, options) {
    await rm(filepath, options)
  }

  async function readdir(filepath) {
    filepath = normalize(filepath)
    if (!directories.has(filepath)) {
      if (files.has(filepath) || symlinks.has(filepath))
        throw filesystemError('ENOTDIR', filepath)
      throw filesystemError('ENOENT', filepath)
    }
    const prefix = filepath === '/' ? '/' : `${filepath}/`
    const children = new Set()
    for (const candidate of [
      ...directories,
      ...files.keys(),
      ...symlinks.keys(),
    ]) {
      if (!candidate.startsWith(prefix) || candidate === filepath) continue
      const relative = candidate.slice(prefix.length)
      if (relative && !relative.includes('/')) children.add(relative)
    }
    return [...children]
  }

  async function readlink(filepath, options = {}) {
    filepath = normalize(filepath)
    if (!symlinks.has(filepath)) throw filesystemError('EINVAL', filepath)
    const target = symlinks.get(filepath)
    return options.encoding === 'buffer' ? Buffer.from(target) : target
  }

  async function symlink(target, filepath) {
    filepath = normalize(filepath)
    if (!directories.has(parent(filepath)))
      throw filesystemError('ENOENT', parent(filepath))
    if (
      files.has(filepath) ||
      symlinks.has(filepath) ||
      directories.has(filepath)
    ) {
      throw filesystemError('EEXIST', filepath)
    }
    symlinks.set(filepath, target)
    stats.delete(filepath)
  }

  const fs = {
    readFile,
    writeFile,
    mkdir,
    rmdir,
    unlink,
    rm,
    stat: async filepath => lstatRecord(filepath),
    lstat: async filepath => lstatRecord(filepath),
    readdir,
    readlink,
    symlink,
  }

  return {
    fs,
    filePaths: () => [...files.keys()],
    getFile: filepath => {
      const contents = files.get(normalize(filepath))
      return contents === undefined ? null : Buffer.from(contents)
    },
    setWriteHook: hook => {
      beforeWrite = hook
    },
  }
}
