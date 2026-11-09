// Minimal read-only asar archive reader used to inspect the installed DSH payload
// (C:\Tools\DeepSeek Harness\resources\app.asar) because shell tools cannot open it.
// Usage:
//   node tools/asar.mjs ls <archive> <pathDir>
//   node tools/asar.mjs cat <archive> <pathFile>
//   node tools/asar.mjs extract <archive> <pathPrefix> <outDir>
import fs from 'node:fs'
import path from 'node:path'

function readHeader (archive) {
  const fd = fs.openSync(archive, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    fs.readSync(fd, sizeBuf, 0, 8, 0)
    const headerSize = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 8)
    // header pickle payload starts at byte 4 in the buffer: uint32 string length, then JSON
    const jsonLen = headerBuf.readUInt32LE(4)
    const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLen).toString('utf8'))
    return { fd, header, baseOffset: 8 + headerSize }
  } catch (err) {
    fs.closeSync(fd)
    throw err
  }
}

function walk (node, prefix, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, `${prefix}/${name}`, out)
  } else {
    out.push({ path: prefix, size: node.size, offset: node.offset, unpacked: node.unpacked })
  }
}

function readEntry (fd, baseOffset, entry) {
  const buf = Buffer.alloc(entry.size)
  if (entry.size === 0) return buf
  fs.readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset))
  return buf
}

const [, , cmd, archive, arg1, arg2] = process.argv
const { fd, header, baseOffset } = readHeader(archive)

try {
  if (cmd === 'ls') {
    const dir = (arg1 ?? '/').replace(/\/+$/, '') || '/'
    let node = header
    for (const part of dir.split('/').filter(Boolean)) {
      node = node.files?.[part]
      if (!node) throw new Error(`not found: ${dir}`)
    }
    const entries = Object.entries(node.files ?? {}).map(([name, child]) =>
      child.files ? `${name}/` : `${name}  (${child.size}${child.unpacked ? ', unpacked' : ''})`)
    console.log(entries.join('\n'))
    console.log(`\n-- ${entries.length} entries in ${dir}`)
  } else if (cmd === 'cat') {
    const all = []
    walk(header, '', all)
    const entry = all.find(e => e.path === arg1)
    if (!entry) throw new Error(`not found: ${arg1}`)
    process.stdout.write(readEntry(fd, baseOffset, entry))
  } else if (cmd === 'extract') {
    const all = []
    walk(header, '', all)
    const prefix = arg1.replace(/\/+$/, '')
    const matched = all.filter(e => e.path === prefix || e.path.startsWith(prefix + '/'))
    if (matched.length === 0) throw new Error(`no files under: ${prefix}`)
    for (const entry of matched) {
      const target = path.join(arg2, entry.path.slice(prefix.length + 1) || path.basename(entry.path))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, readEntry(fd, baseOffset, entry))
    }
    console.log(`extracted ${matched.length} files to ${arg2}`)
  } else {
    console.error('usage: ls|cat|extract')
    process.exitCode = 2
  }
} finally {
  fs.closeSync(fd)
}
