// Materialize the dependency closure this plugin's tests need from the
// installed DeepSeek Harness payload (C:\Tools\DeepSeek Harness\resources\app.asar).
//
// The Host resolves `@deepseek-ai/*` and `@earendil-works/*` through its own
// runtime router, which does not exist in a plain `node --test` process. Tests
// therefore need real files: this script extracts exactly the packages the
// plugin imports (plus their dependency closure) into ./node_modules, where
// Node's own resolver finds them.
//
// Usage: node tools/vendor-runtime-deps.mjs [--force]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.dirname(here)
const archive = process.env.DSH_ASAR ?? 'C:/Tools/DeepSeek Harness/resources/app.asar'
const archiveRoot = '/dsh/node_modules'
const force = process.argv.includes('--force')

const roots = [
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cosmokit',
  '@earendil-works/pi-ai',
]

function readArchive () {
  const fd = fs.openSync(archive, 'r')
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const headerSize = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  fs.readSync(fd, headerBuf, 0, headerSize, 8)
  const jsonLen = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLen).toString('utf8'))
  return { fd, header, baseOffset: 8 + headerSize }
}

const { fd, header, baseOffset } = readArchive()

/** Resolve one archive path to its node. */
function nodeAt (segments) {
  let node = header
  for (const segment of segments) {
    node = node.files?.[segment]
    if (node === undefined) return undefined
  }
  return node
}

/** Every file (not directory) below one package node. */
function filesBelow (node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const next = `${prefix}/${name}`
    if (child.files) filesBelow(child, next, out)
    else out.push({ path: next, size: child.size, offset: child.offset, unpacked: child.unpacked })
  }
  return out
}

function readEntry (entry) {
  if (entry.size === 0) return Buffer.alloc(0)
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset))
  return buf
}

function packageDirOf (name) {
  const node = nodeAt([...archiveRoot.split('/').filter(Boolean), ...name.split('/')])
  return node?.files === undefined ? undefined : node
}

/** Write one package's files under <workspace>/node_modules. */
function extractPackage (name) {
  const node = packageDirOf(name)
  if (node === undefined) return { ok: false, reason: 'not in the installed payload' }
  const files = filesBelow(node, name, [])
  const target = path.join(workspace, 'node_modules', ...name.split('/'))
  if (force) fs.rmSync(target, { recursive: true, force: true })
  let written = 0
  for (const entry of files) {
    if (entry.unpacked) continue
    const relative = entry.path.slice(name.length + 1)
    const out = path.join(target, ...relative.split('/'))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, readEntry(entry))
    written += 1
  }
  return { ok: true, written }
}

function manifestOf (name) {
  const node = packageDirOf(name)
  const file = node?.files?.['package.json']
  if (file === undefined) return undefined
  try {
    return JSON.parse(readEntry(file).toString('utf8'))
  } catch {
    return undefined
  }
}

// Development-only type packages belong to `devDependencies` and are installed
// by npm. The runtime payload carries a metadata-only `@types/node` stub whose
// declaration files are unpacked, so copying it would replace a working type
// package with one tsc cannot read.
const skip = (name) => name.startsWith('@types/')

const queue = roots.filter((name) => !skip(name))
const seen = new Set()
const extracted = []
const missing = []
while (queue.length > 0) {
  const name = queue.shift()
  if (seen.has(name)) continue
  seen.add(name)
  const result = extractPackage(name)
  if (!result.ok) {
    missing.push({ name, reason: result.reason })
    continue
  }
  extracted.push({ name, files: result.written })
  const manifest = manifestOf(name)
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(manifest?.[field] ?? {})) {
      if (!seen.has(dependency) && !skip(dependency)) queue.push(dependency)
    }
  }
}

fs.closeSync(fd)
console.log(`extracted ${extracted.length} packages into node_modules/`)
for (const item of extracted) console.log(`  ${item.name} (${item.files} files)`)
if (missing.length > 0) {
  console.log('not present in the installation (ignored):')
  for (const item of missing) console.log(`  ${item.name}: ${item.reason}`)
}
