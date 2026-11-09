// Run every test file in one process.
//
// `node --test` spawns a child process per file, and this session's Windows
// sandbox denies the pipe that capture requires, so the suite is imported
// directly instead: node:test still registers and reports each case, and the
// runner sets a non-zero exit code when any case fails.
//
// Usage: node tools/run-tests.mjs [name-filter]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.join(path.dirname(here), 'test')
const filter = process.argv[2]

const files = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => filter === undefined || name.includes(filter))
  .sort()

if (files.length === 0) {
  console.error(`no test files matched ${filter ?? '(all)'}`)
  process.exit(1)
}

for (const file of files) {
  await import(pathToFileURL(path.join(testDir, file)).href)
}
