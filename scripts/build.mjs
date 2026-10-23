/**
 * Build `lib/` from `src/` with no dependencies at all.
 *
 * The shipped plugin is two artifacts with two different module formats:
 *
 *  - `lib/index.js` — the host half. Plain ESM; Node loads it through the
 *    profile's loader row.
 *  - `lib/client.js` — the browser half. A **classic script** (not ESM) that
 *    calls `window.__ModuleLoader__.load({ id, factory })`, because the module
 *    system injects it with a `<script>` tag and materialises the factory
 *    lazily.
 *
 * TypeScript is erased with Node's own `module.stripTypeScriptTypes`, so the
 * build needs neither a bundler nor a network install. The client source is
 * deliberately written without JSX and without any import statement: it reaches
 * React through the factory's `require`, which resolves against the shell's
 * frozen module table (`react`, `react-dom`,
 * `@deepseek-ai/dsh-client-ui-primitives`, …). Nothing has to be bundled, and
 * nothing has to be declared as an external.
 *
 * Run with `node scripts/build.mjs` (also wired to `pnpm build`/`prepare`).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(root, 'lib')

/**
 * Erase TypeScript syntax from one source file.
 * @param relativePath - path relative to the package root.
 * @returns the emitted JavaScript.
 */
async function strip(relativePath) {
  const absolute = join(root, relativePath)
  const source = await readFile(absolute, 'utf8')
  // `mode: 'strip'` only erases; it never rewrites values, so the emitted code
  // keeps the exact semantics of the source.
  return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: relativePath })
}

/**
 * Indent a block so the emitted bundle stays readable.
 * @param text - the block to indent.
 * @param depth - number of leading tabs per non-empty line.
 * @returns the indented block.
 */
function indent(text, depth) {
  const pad = '\t'.repeat(depth)
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${pad}${line}`))
    .join('\n')
}

/**
 * Wrap the client body in the loader factory.
 *
 * The `id` must equal the package name: it is the module table's key, and the
 * loader rejects a second registration of the same id.
 *
 * @param packageName - the package name from package.json.
 * @param body - the stripped client source.
 * @returns the complete classic script.
 */
function wrapClient(packageName, body) {
  return [
    `window.__ModuleLoader__.load({`,
    `\tid: ${JSON.stringify(packageName)},`,
    `\tfactory: (require) => {`,
    `\t\tvar module = { exports: {} };`,
    `\t\tvar exports = module.exports;`,
    indent(body, 2),
    `\t\t// The module namespace object is the Cordis plugin: named \`apply\` and \`inject\`.`,
    `\t\tmodule.exports = createDshFileSelector(require);`,
    `\t\treturn module.exports;`,
    `\t}`,
    `});`,
    ``,
  ].join('\n')
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await mkdir(libDir, { recursive: true })

const host = await strip('src/index.ts')
await writeFile(join(libDir, 'index.js'), host, 'utf8')

const clientBody = await strip('src/client/index.ts')
const client = wrapClient(pkg.name, clientBody)
await writeFile(join(libDir, 'client.js'), client, 'utf8')

// The client must be a syntactically valid classic script. Compiling it here
// (without running it) catches a bad wrapper before DSH ever loads the bundle.
try {
  new Function(client)
} catch (error) {
  throw new Error(`lib/client.js is not a valid classic script: ${error.message}`)
}

if (!client.includes('window.__ModuleLoader__.load(')) {
  throw new Error('lib/client.js is missing the module-loader call')
}

process.stdout.write(
  [
    `built ${relative(root, join(libDir, 'index.js'))} (${host.length} B) — host half, ESM`,
    `built ${relative(root, join(libDir, 'client.js'))} (${client.length} B) — browser half, classic script`,
    '',
  ].join('\n'),
)
