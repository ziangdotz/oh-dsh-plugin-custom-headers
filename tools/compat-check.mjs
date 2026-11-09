// Read-only compatibility report for the DSH installation this plugin runs on.
//
// It answers two questions before you install or upgrade:
//   1. Do the peer packages and the `engines.dsh` range still match?
//   2. Are the internal seams this plugin relies on still present?
//
// Usage:
//   node tools/compat-check.mjs
//   node tools/compat-check.mjs --asar "C:\Path\app.asar"
//   node tools/compat-check.mjs --json
//
// `DSH_ASAR` is honored when --asar is absent. The default matches the
// Windows Desktop installation used during development.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.dirname(here)
const plugin = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'))

/** Read one CLI option value. */
function option (name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const asJson = process.argv.includes('--json')
const archivePath = option('--asar') ?? process.env.DSH_ASAR ?? 'C:/Tools/DeepSeek Harness/resources/app.asar'

/** Read the asar header once; keep the descriptor for entry reads. */
function openArchive (file) {
  if (!fs.existsSync(file)) throw new Error(`archive not found: ${file}`)
  const fd = fs.openSync(file, 'r')
  const size = Buffer.alloc(8)
  fs.readSync(fd, size, 0, 8, 0)
  const headerSize = size.readUInt32LE(4)
  const headerBuffer = Buffer.alloc(headerSize)
  fs.readSync(fd, headerBuffer, 0, headerSize, 8)
  const jsonLength = headerBuffer.readUInt32LE(4)
  const header = JSON.parse(headerBuffer.subarray(8, 8 + jsonLength).toString('utf8'))
  return { fd, header, baseOffset: 8 + headerSize }
}

/** Resolve one archive path to its node. */
function nodeAt (header, segments) {
  let node = header
  for (const segment of segments) {
    node = node.files?.[segment]
    if (node === undefined) return undefined
  }
  return node
}

/** Read one packed file as UTF-8, or undefined when the path is absent/unpacked. */
function readText (archive, file) {
  const segments = file.split('/').filter(Boolean)
  const entry = nodeAt(archive.header, segments)
  if (entry === undefined || entry.files !== undefined || entry.unpacked) return undefined
  const buffer = Buffer.alloc(entry.size)
  if (entry.size > 0) fs.readSync(archive.fd, buffer, 0, entry.size, archive.baseOffset + Number(entry.offset))
  return buffer.toString('utf8')
}

/** Read one package manifest from the installation's node_modules. */
function manifestOf (archive, name) {
  const text = readText(archive, `/dsh/node_modules/${name}/package.json`)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Parse `1.2.3-rc.4` into comparable pieces. */
function parseVersion (value) {
  const cleaned = String(value).trim().replace(/^v/, '')
  const plus = cleaned.split('+')[0]
  const dash = plus.indexOf('-')
  const core = (dash === -1 ? plus : plus.slice(0, dash)).split('.').map((part) => Number(part) || 0)
  const prerelease = dash === -1 ? [] : plus.slice(dash + 1).split('.')
  return { core, prerelease }
}

/** Compare two versions; returns -1, 0, or 1. */
function compareVersion (left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/.test(leftPart)
    const rightNumber = /^\d+$/.test(rightPart)
    if (leftNumber && rightNumber) {
      const difference = Number(leftPart) - Number(rightPart)
      if (difference !== 0) return difference > 0 ? 1 : -1
    } else if (leftNumber !== rightNumber) {
      return leftNumber ? -1 : 1
    } else if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1
    }
  }
  return 0
}

/** Whether a version falls inside one comparator token. */
function satisfiesToken (version, token) {
  if (token === '' || token === '*') return true
  if (token.startsWith('~')) {
    const base = parseVersion(token.slice(1))
    const upper = [base.core[0], base.core[1] + 1, 0].join('.')
    return compareVersion(version, token.slice(1)) >= 0 && compareVersion(version, upper) < 0
  }
  if (token.startsWith('^')) {
    const base = parseVersion(token.slice(1))
    const upper = base.core[0] > 0
      ? [base.core[0] + 1, 0, 0].join('.')
      : base.core[1] > 0
        ? [0, base.core[1] + 1, 0].join('.')
        : [0, 0, base.core[2] + 1].join('.')
    return compareVersion(version, token.slice(1)) >= 0 && compareVersion(version, upper) < 0
  }
  const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token)
  if (match === null) return false
  const [, operator = '=', target] = match
  const difference = compareVersion(version, target)
  if (operator === '>=') return difference >= 0
  if (operator === '<=') return difference <= 0
  if (operator === '>') return difference > 0
  if (operator === '<') return difference < 0
  return difference === 0
}

/** Standard npm range subset: `||`, comparators, `~`, `^`, and `x.y.z`. */
function satisfies (version, range) {
  return String(range).split('||').some((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean)
    return tokens.every((token) => satisfiesToken(version, token))
  })
}

const rows = []
let failures = 0
let warnings = 0

/** Record one check. */
function record (level, area, name, detail) {
  rows.push({ level, area, name, detail })
  if (level === 'FAIL') failures += 1
  if (level === 'WARN') warnings += 1
}

let archive
try {
  archive = openArchive(archivePath)
} catch (error) {
  console.error(`compat-check: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

try {
  for (const [name, range] of Object.entries(plugin.peerDependencies ?? {})) {
    const manifest = manifestOf(archive, name)
    if (manifest === undefined) {
      record('WARN', 'peer', name, `not found in the installation; wants ${range}`)
      continue
    }
    const ok = satisfies(manifest.version, range)
    record(ok ? 'PASS' : 'FAIL', 'peer', name, `${manifest.version} (wants ${range})`)
  }

  const dshManifest = manifestOf(archive, '@deepseek-ai/dsh')
  if (dshManifest === undefined) {
    record('WARN', 'engine', 'dsh', 'installation version not found')
  } else {
    const range = plugin.engines?.dsh ?? '*'
    const ok = satisfies(dshManifest.version, range)
    record(ok ? 'PASS' : 'FAIL', 'engine', 'dsh', `${dshManifest.version} (wants ${range})`)
  }

  const probes = [
    {
      name: 'PiAiAdapter honors profile.piProvider',
      file: '/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
      patterns: ['profile.piProvider'],
    },
    {
      name: 'dsh-llm-pi-ai filters attribution header collisions',
      file: '/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
      patterns: ['function requestHeaders', 'attributionHeaders'],
    },
    {
      name: 'pi-ai merges options.headers last (openai-completions)',
      file: '/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js',
      patterns: ['Merge options headers last'],
    },
    {
      name: 'pi-ai merges options.headers last (openai-responses)',
      file: '/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js',
      patterns: ['Merge options headers last'],
    },
    {
      name: 'pi-ai merges options.headers last (anthropic-messages)',
      file: '/dsh/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js',
      patterns: ['mergeClientHeaders'],
    },
    {
      name: 'dsh-llm exposes registerAdapter',
      file: '/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
      patterns: ['registerAdapter('],
    },
    {
      name: 'dsh-llm exposes registerModelDiscovery',
      file: '/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
      patterns: ['registerModelDiscovery('],
    },
    {
      name: 'dsh-llm exposes attributionHeaders',
      file: '/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
      patterns: ['attributionHeaders'],
    },
    {
      name: 'settings client serves settings.section',
      file: '/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js',
      patterns: ['settings.section'],
      optional: true,
    },
    {
      name: 'settings client serves configForms',
      file: '/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js',
      patterns: ['configForms'],
      optional: true,
    },
  ]

  for (const probe of probes) {
    const text = readText(archive, probe.file)
    if (text === undefined) {
      record(probe.optional === true ? 'WARN' : 'FAIL', 'seam', probe.name, `missing file ${probe.file}`)
      continue
    }
    const absent = probe.patterns.filter((pattern) => !text.includes(pattern))
    if (absent.length > 0) {
      record('FAIL', 'seam', probe.name, `missing: ${absent.join(', ')}`)
    } else {
      record('PASS', 'seam', probe.name, 'present')
    }
  }
} finally {
  fs.closeSync(archive.fd)
}

const result = failures === 0 ? 'COMPATIBLE' : 'NEEDS PORT'
if (asJson) {
  process.stdout.write(`${JSON.stringify({ archive: archivePath, plugin: `${plugin.name}@${plugin.version}`, result, failures, warnings, rows }, null, 2)}\n`)
} else {
  const width = rows.reduce((max, row) => Math.max(max, row.name.length), 0)
  console.log(`DSH compatibility report`)
  console.log(`  archive: ${archivePath}`)
  console.log(`  plugin:  ${plugin.name}@${plugin.version}`)
  console.log('')
  for (const row of rows) {
    console.log(`  ${row.level.padEnd(4)} ${row.area.padEnd(6)} ${row.name.padEnd(width)}  ${row.detail}`)
  }
  console.log('')
  console.log(`Result: ${result} (${failures} failure(s), ${warnings} warning(s))`)
}
process.exitCode = failures === 0 ? 0 : 1
