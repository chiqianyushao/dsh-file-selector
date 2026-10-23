/**
 * Verify the built plugin, without a browser and without dependencies.
 *
 * Every failure this plugin has had was a *client runtime* failure, and none of
 * them were visible in the source:
 *
 *  - a Cordis service read on a context that did not inject it (which surfaced
 *    as a bare HTTP 400 on every request);
 *  - a stacking-order mistake that hid the menu behind the drawer;
 *  - a React identity mistake that reset the tree on every render;
 *  - an append that depended on a slot the composer renders only when it has an
 *    extension zone, so the menu appeared and did nothing;
 *  - a `blur` listener registered in the capture phase, which tore the menu down
 *    during the click's own focus transition — removing the row before `mouseup`
 *    so the `click` never fired, killing **both** rows at once.
 *
 * So this harness materialises the real `lib/client.js` against a fake DOM, a
 * fake React and fake `sessions`/`uiSession` services, then **drives it**. The
 * fake DOM models event phases (capture, bubble, and non-bubbling types) and
 * every row click is delivered as a real click sequence — pointerdown, the focus
 * transition, then click — because that is the shape that hid the last bug.
 *
 * Run with `node scripts/verify.mjs` (also wired to `pnpm test`).
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
const failures = []

/**
 * Print the tally, once.
 *
 * Registered with the crash handlers immediately below, so a failure part-way
 * through the driven scenarios still names the assertions that already failed
 * instead of hiding them behind one stack trace.
 */
let reported = false
function report() {
  if (reported) return
  reported = true
  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} of ${checks} checks failed:\n`)
    for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`)
    process.stdout.write('\n')
    process.exitCode = 1
  } else {
    process.stdout.write(`all checks passed (${checks})\n`)
  }
}

process.on('exit', report)
process.on('uncaughtException', (error) => {
  failures.push(`the harness crashed: ${error.message}`)
  report()
  process.exit(1)
})

/**
 * Render one observed value for a failure message, tolerating a circular one.
 * @param value - the value to describe.
 * @returns a short, JSON-shaped description.
 */
function describe(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/**
 * Record one assertion.
 * @param label - what is being asserted.
 * @param ok - the assertion's outcome.
 */
function check(label, ok) {
  checks += 1
  if (!ok) failures.push(label)
}

/**
 * Record one equality assertion.
 * @param label - what is being asserted.
 * @param actual - the observed value.
 * @param expected - the required value.
 */
function equal(label, actual, expected) {
  const ok = actual === expected
  check(ok ? label : `${label} — got ${describe(actual)}, want ${describe(expected)}`, ok)
}

/**
 * Record one deep-equality assertion over JSON-shaped values.
 * @param label - what is being asserted.
 * @param actual - the observed value.
 * @param expected - the required value.
 */
function deepEqual(label, actual, expected) {
  const a = describe(actual)
  const b = describe(expected)
  check(a === b ? label : `${label} — got ${a}, want ${b}`, a === b)
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// ── fake DOM ───────────────────────────────────────────────────────────────
//
// Enough of the DOM for the plugin's own calls *and* for the event model that
// hid the last bug: listeners keep their capture flag, dispatch walks the
// ancestor chain in capture order then bubble order, and the types that do not
// bubble are dispatched to their target only.

/** Event types the DOM does not bubble. */
const NON_BUBBLING = new Set(['blur', 'focus'])

/** A listener registry that remembers each listener's phase. */
class ListenerBag {
  constructor() {
    this.entries = new Map()
  }

  add(type, listener, capture) {
    const list = this.entries.get(type) ?? []
    list.push({ listener, capture: capture === true })
    this.entries.set(type, list)
  }

  remove(type, listener) {
    const list = this.entries.get(type)
    if (list === undefined) return
    const at = list.findIndex((entry) => entry.listener === listener)
    if (at >= 0) list.splice(at, 1)
  }

  /** Visit the listeners of one type registered in one phase. */
  each(type, capture, visit) {
    for (const entry of [...(this.entries.get(type) ?? [])]) {
      if (entry.capture === capture) visit(entry.listener)
    }
  }

  /** Visit every listener of one type, in registration order, either phase. */
  eachInOrder(type, visit) {
    for (const entry of [...(this.entries.get(type) ?? [])]) visit(entry.listener)
  }

  /** How many listeners are registered for one type, either phase. */
  count(type) {
    return (this.entries.get(type) ?? []).length
  }

  /** How many listeners of one type are registered in one phase. */
  countPhase(type, capture) {
    return (this.entries.get(type) ?? []).filter((entry) => entry.capture === capture).length
  }
}

/** The subset of selectors this plugin asks `closest` for. */
const SELECTORS = {
  '[data-files-entry]': (node) => node.hasAttribute('data-files-entry'),
  '[data-files-path]': (node) => node.hasAttribute('data-files-path'),
  '[data-files-root]': (node) => node.hasAttribute('data-files-root'),
  '[data-textpreview-body]': (node) => node.hasAttribute('data-textpreview-body'),
  '[data-textpreview-url]': (node) => node.hasAttribute('data-textpreview-url'),
  '[data-textpreview-line]': (node) => node.hasAttribute('data-textpreview-line'),
  'pre .line': (node) => node.classList.has('line') && node.parentElement?.tagName === 'PRE',
}

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType
    this.parentElement = null
  }
}

class FakeClassList {
  constructor(element) {
    this.element = element
  }

  /** Whether the element carries this class. */
  has(name) {
    return this.element.className.split(/\s+/).includes(name)
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super(1)
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.dataset = {}
    this.style = {}
    this.listeners = new ListenerBag()
    this.className = ''
    this.textContent = ''
    this.title = ''
    this.value = ''
    this.classList = new FakeClassList(this)
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this
      this.children.push(node)
    }
  }

  remove() {
    const parent = this.parentElement
    if (parent === null) return
    const at = parent.children.indexOf(this)
    if (at >= 0) parent.children.splice(at, 1)
    this.parentElement = null
  }

  addEventListener(type, listener, capture) {
    this.listeners.add(type, listener, capture)
  }

  removeEventListener(type, listener) {
    this.listeners.remove(type, listener)
  }

  contains(node) {
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }

  getBoundingClientRect() {
    return { width: 220, height: 44, left: 0, top: 0, right: 220, bottom: 44 }
  }

  /** Record this field as the document's selection, as `select()` does. */
  select() {
    fakeDocument.selectedField = this
  }

  closest(selector) {
    const matches = SELECTORS[selector]
    if (matches === undefined) throw new Error(`verify: unsupported selector ${selector}`)
    let node = this
    while (node !== null && node !== undefined) {
      if (node.nodeType === 1 && matches(node)) return node
      node = node.parentElement
    }
    return null
  }

  querySelectorAll() {
    return []
  }

  querySelector() {
    return null
  }
}

/** Text copied through the selection fallback, in order. */
const selectionCopies = []

const fakeDocument = {
  head: new FakeElement('head'),
  body: new FakeElement('body'),
  listeners: new ListenerBag(),
  /** The field `select()` last claimed, read by the fake `execCommand`. */
  selectedField: null,
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => null,
  addEventListener(type, listener, capture) {
    this.listeners.add(type, listener, capture)
  },
  removeEventListener(type, listener) {
    this.listeners.remove(type, listener)
  },
  /**
   * The legacy copy command. Its outcome is switchable so the harness can drive
   * the "both clipboard paths failed" branch.
   */
  execCommand(command) {
    if (command !== 'copy' || this.selectedField === null || !selectionCopyWorks) return false
    selectionCopies.push(this.selectedField.value)
    return true
  },
}

/** Whether `execCommand('copy')` reports success. */
let selectionCopyWorks = true

/** The selection `window.getSelection()` currently answers. */
let currentSelection = null

const fakeWindow = {
  innerWidth: 1200,
  innerHeight: 800,
  listeners: new ListenerBag(),
  addEventListener(type, listener, capture) {
    this.listeners.add(type, listener, capture)
  },
  removeEventListener(type, listener) {
    this.listeners.remove(type, listener)
  },
  getSelection: () => currentSelection,
}

/**
 * Dispatch one event the way a browser does.
 *
 * Three legs: capture from the root down to the target's parent, then the target
 * itself (where *both* phases' listeners run, in registration order — which is
 * why a `window` blur still reaches a non-capturing listener on window), then
 * bubbling from the target's parent back up, and only when the type bubbles.
 *
 * That last rule is what makes a capturing `window` listener the only kind that
 * hears a descendant's `blur` — the exact mistake that removed a menu row
 * mid-click.
 *
 * @param target - the element (or the document/window) the event is aimed at.
 * @param type - the event type.
 * @param extra - additional event fields.
 */
function fireEvent(target, type, extra = {}) {
  const path = []
  if (target !== fakeDocument && target !== fakeWindow) {
    for (let node = target; node !== null && node !== undefined; node = node.parentElement) path.push(node)
  }
  if (target !== fakeWindow) path.push(fakeDocument)
  path.push(fakeWindow)
  const event = (node) => ({ ...extra, type, target, currentTarget: node })
  const each = (node, capture, visit) => node.listeners.each(type, capture, (listener) => listener(event(node)))
  for (const node of [...path].reverse().slice(0, -1)) each(node, true, null)
  target.listeners.eachInOrder(type, (listener) => listener(event(target)))
  if (!NON_BUBBLING.has(type)) for (const node of path.slice(1)) each(node, false, null)
}

/** Texts handed to the async clipboard, in order. */
const clipboardWrites = []
/** Whether the async clipboard refuses, so the fallback can be exercised. */
let clipboardRefuses = false

const fakeNavigator = {
  clipboard: {
    writeText: (text) => {
      if (clipboardRefuses) return Promise.reject(new Error('NotAllowedError: write denied'))
      clipboardWrites.push(text)
      return Promise.resolve()
    },
  },
}

const logs = []
const warnings = []
const fakeConsole = {
  log: (...args) => logs.push(args.join(' ')),
  warn: (...args) => warnings.push(args.join(' ')),
  error: () => {},
}

// ── fake React ─────────────────────────────────────────────────────────────

const fakeReact = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }
  },
  useMemo: (factory) => factory(),
  useEffect: (effect) => {
    effect()
  },
}

/**
 * Flatten the text a rendered element description carries.
 * @param node - a description, a string, or an array of either.
 * @returns the concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

// ── materialise the bundle ─────────────────────────────────────────────────

const clientSource = await readFile(join(root, 'lib/client.js'), 'utf8')

let loaded = null
fakeWindow.__ModuleLoader__ = {
  load(registration) {
    loaded = registration
  },
}

const requireCalls = []
const runBundle = new Function('window', 'document', 'navigator', 'Node', 'Element', 'console', clientSource)
runBundle(fakeWindow, fakeDocument, fakeNavigator, FakeNode, FakeElement, fakeConsole)

check('lib/client.js registers with the module loader', loaded !== null)
equal('the loaded module id is the package name', loaded?.id, pkg.name)
equal('the client bundle is a classic script loader call', clientSource.includes('window.__ModuleLoader__.load('), true)

const fakeRequire = (specifier) => {
  requireCalls.push(specifier)
  if (specifier === 'react') return fakeReact
  throw new Error(`verify: unexpected require("${specifier}")`)
}

const plugin = loaded.factory(fakeRequire)
deepEqual('the bundle requires only react from the frozen table', requireCalls, ['react'])
check('the module namespace exposes apply', typeof plugin.apply === 'function')
deepEqual('the client half injects only slots', plugin.inject, ['slots'])

// ── the framework the plugin reads at gesture time ─────────────────────────
//
// `sessions.list.getSnapshot()` gives the current session id and its cwd;
// `uiSession.resolve(id)` gives the `{ hooks, props }` bundle the framework
// hands slot occupants — `props.inputActions` and `hooks.input` included. Each
// fake session keeps its own draft, so a write to the wrong one is visible.

/**
 * Build one fake session with its own draft and write log.
 * @param id - the session id.
 * @param cwd - its workspace root.
 * @returns the session's handles.
 */
function makeSession(id, cwd) {
  const state = { draft: '', writes: [] }
  const binding = {
    // The binding's own key is the only session identity 0.1.7 still publishes.
    key: id,
    props: {
      inputActions: {
        setDraft: (text) => {
          state.draft = text
          state.writes.push(text)
        },
        submit: () => {
          throw new Error('verify: the plugin must never submit')
        },
      },
    },
    hooks: { input: { getSnapshot: () => ({ draft: state.draft }) } },
  }
  return { id, cwd, state, binding }
}

const primary = makeSession('s1', 'E:/ws')
const secondary = makeSession('s2', 'E:/other')
const sessionsById = { s1: primary, s2: secondary }
const bindings = { s1: primary.binding, s2: secondary.binding }
/** Sessions `uiSession` refuses to materialize (to exercise the degraded path). */
const unresolvable = new Set()

/** The session the fake app is showing. */
let currentSessionId = 's1'

/**
 * Which `uiSession` seam the fake harness exposes.
 *
 * `adapter` is the 0.1.7-rc.2 shape (`adapter.current.getSnapshot()`), which is
 * what the app's own right sidebar reads. `resolve` is the 0.1.5-rc.2 shape
 * (`resolve(sessionId)`), kept so the compatibility ladder is exercised in both
 * directions rather than only where the current harness happens to point.
 */
let uiSessionShape = 'adapter'

const services = {
  sessions: {
    list: {
      getSnapshot: () => ({
        byId: Object.fromEntries(Object.entries(sessionsById).map(([id, session]) => [id, { cwd: session.cwd }])),
        // 0.1.7 stopped publishing this; 0.1.5-rc.2 had it, and the older
        // `resolve(sessionId)` shape needs it.
        ...(uiSessionShape === 'resolve' ? { current: currentSessionId } : {}),
      }),
    },
  },
  uiSession: {
    /** The 0.1.7 seam, read fresh so shape switches take effect immediately. */
    get adapter() {
      if (uiSessionShape !== 'adapter') return undefined
      const id = currentSessionId
      return { current: { getSnapshot: () => (unresolvable.has(id) ? undefined : bindings[id]) } }
    },
    /** The 0.1.5-rc.2 seam. */
    resolve(id) {
      if (uiSessionShape !== 'resolve') return undefined
      return unresolvable.has(id) ? undefined : bindings[id]
    },
  },
}

// ── drive `apply` against a strict context ─────────────────────────────────
//
// Direct service properties are refused, exactly as Cordis refuses them ("cannot
// get property … without inject"): the one time this plugin read a service it
// had not declared, every request answered a bare HTTP 400. Services must be
// reached through `ctx.get`, which is why the proxy models that split.

const registrations = []
const injectedSlots = []

const slotsService = {
  inject(name, callback) {
    injectedSlots.push(name)
    return callback()
  },
  register(options, Component) {
    registrations.push({ options, Component })
    return () => {}
  },
}

services.slots = slotsService

const directReads = []
const effectLabels = []
const strictContext = new Proxy(
  {},
  {
    get(_target, property) {
      directReads.push(String(property))
      if (property === 'effect') {
        return (callback, label) => {
          effectLabels.push(label)
          const dispose = callback()
          return typeof dispose === 'function' ? dispose : () => {}
        }
      }
      if (property === 'get') return (name) => services[name]
      // `slots` is the one service the plugin declares, so reading it as a
      // property is legal; every other service must go through `get`.
      if (property === 'slots') return slotsService
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
  },
)

let applyError = null
try {
  plugin.apply(strictContext)
} catch (error) {
  applyError = error
}
check(`apply runs against a context that only declares slots (${applyError?.message ?? 'no error'})`, applyError === null)
deepEqual('apply itself touches only effect and the declared slots service', [...new Set(directReads)].sort(), [
  'effect',
  'slots',
])

equal('apply registers exactly one slot occupant', registrations.length, 1)
deepEqual('apply injects into exactly the documented slot', injectedSlots, ['sidebar.right.tab.menu.item'])

const menuRegistration = registrations.find((entry) => entry.options.name === 'sidebar.right.tab.menu.item')
check('the menu entry registers into sidebar.right.tab.menu.item', menuRegistration !== undefined)
deepEqual('the menu registration carries only name/id/order', Object.keys(menuRegistration?.options ?? {}).sort(), [
  'id',
  'name',
  'order',
])
equal('the menu entry id is stable', menuRegistration?.options.id, 'file-selector-add-to-conversation')

equal('the stylesheet is injected once', fakeDocument.head.children.filter((node) => node.tagName === 'STYLE').length, 1)
equal('the selection tracker is attached', fakeDocument.listeners.count('selectionchange'), 1)
equal('the context menu is claimed in the capture phase', fakeDocument.listeners.countPhase('contextmenu', true), 1)
check(
  'the plugin logs its activation',
  logs.some((line) => line.includes('client half loaded')),
)
equal('the plugin never registers a composer-dock anchor', injectedSlots.includes('conversation.composer.dock'), false)

// ── the built-in tree row ──────────────────────────────────────────────────

/** The workspace the built-in tree is showing. */
const WORKSPACE = 'E:/ws'

/** The tree container the built-in browser renders its rows into. */
const treeRoot = new FakeElement('div')
treeRoot.setAttribute('data-files-root', WORKSPACE)
fakeDocument.body.append(treeRoot)

/**
 * Build one fake tree row the way the built-in browser does.
 * @param kind - the built-in `data-files-entry` value.
 * @param absolutePath - the built-in `data-files-path` value.
 * @returns the row and the name span a click would land on.
 */
function treeRow(kind, absolutePath) {
  const item = new FakeElement('li')
  item.setAttribute('data-files-entry', kind)
  item.setAttribute('data-files-path', absolutePath)
  const button = new FakeElement('button')
  const name = new FakeElement('span')
  button.append(name)
  item.append(button)
  treeRoot.append(item)
  return { item, name }
}

/**
 * Fire the delegated contextmenu handler at one target.
 * @param target - the element the pointer landed on.
 * @param x - pointer client X.
 * @param y - pointer client Y.
 * @returns whether the plugin called `preventDefault`.
 */
function rightClick(target, x = 40, y = 60) {
  let prevented = false
  fireEvent(target, 'contextmenu', {
    clientX: x,
    clientY: y,
    preventDefault: () => {
      prevented = true
    },
  })
  return prevented
}

/** The open body-level menu, or null. */
function openMenuElement() {
  return fakeDocument.body.children.find((node) => node.className === 'dfs-menu') ?? null
}

/** The visible failure notice, or null. */
function noticeElement() {
  return fakeDocument.body.children.find((node) => node.className === 'dfs-notice') ?? null
}

/** The label text of each row in the open menu. */
function menuLabels() {
  const menu = openMenuElement()
  if (menu === null) return []
  return menu.children.map((row) => row.children[0]?.textContent ?? '')
}

/** The mono reference of each row in the open menu. */
function menuRefs() {
  const menu = openMenuElement()
  if (menu === null) return []
  return menu.children.map((row) => row.children[1]?.textContent ?? '')
}

/** Whether each row in the open menu is an inert state report. */
function menuInert() {
  const menu = openMenuElement()
  if (menu === null) return []
  return menu.children.map((row) => row.getAttribute('aria-disabled') === 'true')
}

/**
 * Find one menu row by its label.
 * @param label - the row's label text.
 * @returns the row element.
 */
function menuRow(label) {
  const menu = openMenuElement()
  if (menu === null) throw new Error('verify: no menu is open')
  const row = menu.children.find((candidate) => candidate.children[0]?.textContent === label)
  if (row === undefined) throw new Error(`verify: no row labelled ${label}`)
  return row
}

/**
 * Click one menu row the way a browser delivers a click.
 *
 * The focus transition is the important part: pressing a row focuses it, which
 * blurs whatever had focus, and that `blur` is dispatched *before* `mouseup`.
 * A menu that dismisses itself on it removes the row from the document, so the
 * `click` is never dispatched at all — which is precisely how both rows went
 * dead in the browser while every earlier assertion here stayed green.
 *
 * @param label - the row's label text.
 */
function clickRow(label) {
  const row = menuRow(label)
  if (row.getAttribute('aria-disabled') === 'true') throw new Error(`verify: row ${label} is inert`)
  fireEvent(row, 'pointerdown', {})
  fireEvent(row, 'blur', {})
  check(`the menu survives the focus transition before "${label}" is clicked`, openMenuElement() !== null)
  if (openMenuElement() === null) return
  fireEvent(row, 'click', {})
}

/** Reset the session the reader is in, and its draft. */
function useSession(id) {
  currentSessionId = id
  sessionsById[id].state.draft = ''
  sessionsById[id].state.writes.length = 0
}

const fileRow = treeRow('file', `${WORKSPACE}/src/main.ts`)
equal('right-clicking a tree row is claimed', rightClick(fileRow.name), true)
deepEqual('a file row offers add-to-conversation and copy-path', menuLabels(), ['添加到对话', '复制路径'])
deepEqual('a file row offers no inert report', menuInert(), [false, false])
deepEqual('the file row shortens the absolute path to the workspace', menuRefs(), ['src/main.ts', 'src/main.ts'])

clickRow('添加到对话')
deepEqual('clicking add-to-conversation appends the path to the draft', primary.state.writes, ['src/main.ts'])
equal('the menu closes after a row acts', openMenuElement(), null)

// A second append rides whatever the draft now holds.
rightClick(treeRow('directory', `${WORKSPACE}/src/client`).name)
clickRow('添加到对话')
deepEqual('a directory row appends onto the existing draft', primary.state.writes, ['src/main.ts', 'src/main.ts\nsrc/client'])

// Copy-path never touches the draft.
const beforeCopy = primary.state.writes.length
rightClick(fileRow.name)
clickRow('复制路径')
equal('copy-path leaves the draft alone', primary.state.writes.length, beforeCopy)
deepEqual('copy-path writes the workspace-relative path', clipboardWrites, ['src/main.ts'])

// A path outside the workspace keeps its absolute spelling.
rightClick(treeRow('file', 'E:/other/notes.md').name)
deepEqual('a path outside the workspace is kept absolute', menuRefs(), ['E:/other/notes.md', 'E:/other/notes.md'])

// The tree's own root wins over the session cwd, so the reference matches the
// very tree the reader is pointing at.
rightClick(treeRow('file', 'E:/elsewhere/deep/file.ts').name)
deepEqual('an unrelated absolute path is left alone', menuRefs(), ['E:/elsewhere/deep/file.ts', 'E:/elsewhere/deep/file.ts'])

// ── the clipboard's two paths ──────────────────────────────────────────────

// A refused async write falls back to the selection command instead of
// vanishing. The refusal used to be swallowed, which is why a dead copy and a
// dead add looked identical from the outside.
clipboardRefuses = true
const beforeFallback = selectionCopies.length
rightClick(fileRow.name)
clickRow('复制路径')
await new Promise((resolve) => setTimeout(resolve, 0))
deepEqual('a refused clipboard falls back to the selection command', selectionCopies.slice(beforeFallback), ['src/main.ts'])
check(
  'a fallback that worked is not reported as a failure',
  warnings.every((line) => !line.includes('copy-path failed')),
)

// When both paths refuse, the failure is reported rather than swallowed.
clipboardRefuses = true
selectionCopyWorks = false
rightClick(fileRow.name)
clickRow('复制路径')
await new Promise((resolve) => setTimeout(resolve, 0))
check(
  'a refused copy with no fallback is reported',
  warnings.some((line) => line.includes('复制路径失败')),
)
equal(
  'and the reader sees it, not just the console',
  noticeElement()?.textContent.includes('复制路径失败'),
  true,
)
clipboardRefuses = false
selectionCopyWorks = true

// ── a write that silently does not land ────────────────────────────────────

// `setDraft` that accepts and ignores is the worst failure mode available: the
// click happened, the menu closed, nothing changed. It is now confirmed by
// re-reading the store, and reported on screen when it did not take.
const mute = makeSession('s3', WORKSPACE)
mute.binding.props.inputActions.setDraft = () => {}
sessionsById.s3 = mute
bindings.s3 = mute.binding
currentSessionId = 's3'
rightClick(fileRow.name)
clickRow('添加到对话')
equal(
  'a write that does not land is reported on screen',
  noticeElement()?.textContent.includes('没有落到草稿上'),
  true,
)
deepEqual('and it is reported as a failure, not a success', mute.state.writes, [])
// Back to the first session without clearing its draft: the assertions below
// depend on what it has accumulated.
currentSessionId = 's1'

// ── the write lands in the session the reader is in ────────────────────────

useSession('s2')
rightClick(fileRow.name)
clickRow('添加到对话')
deepEqual('a gesture writes to the current session, not the first one', secondary.state.writes, ['src/main.ts'])
deepEqual('and leaves the other session untouched', primary.state.writes, ['src/main.ts', 'src/main.ts\nsrc/client'])
useSession('s1')

// ── the degraded path says why ─────────────────────────────────────────────

unresolvable.add('s2')
useSession('s2')
rightClick(fileRow.name)
deepEqual('an unresolvable binding still offers a menu', menuLabels(), ['添加到对话不可用', '复制路径'])
deepEqual('the missing capability is reported as inert', menuInert(), [true, false])
deepEqual('and the reason names the seam that failed', menuRefs(), [
  'uiSession exposed no current-session binding',
  'src/main.ts',
])
check(
  'and the reason reaches the console once',
  warnings.some((line) => line.includes('uiSession exposed no current-session binding')),
)
clickRow('复制路径')
deepEqual('copy-path still works while the draft cannot be written', clipboardWrites.at(-1), 'src/main.ts')
unresolvable.delete('s2')
useSession('s1')

// ── the seam has already moved once ────────────────────────────────────────
//
// 0.1.5-rc.2 shipped `uiSession.resolve(sessionId)` and a session list that
// published `current`; 0.1.7 ships `adapter.current` and publishes no `current`
// at all — which is exactly what broke this plugin on the upgrade. The ladder
// is therefore exercised in both directions, and an unknown third shape has to
// name the seam rather than produce a mystery.

uiSessionShape = 'resolve'
const beforeLegacy = primary.state.writes.length
rightClick(fileRow.name)
deepEqual('the 0.1.5-rc.2 seam still resolves the tools', menuLabels(), ['添加到对话', '复制路径'])
clickRow('添加到对话')
equal('and still appends to the draft', primary.state.writes.length, beforeLegacy + 1)

uiSessionShape = 'none'
rightClick(fileRow.name)
deepEqual('an unknown future shape names the missing seam', menuRefs(), [
  'uiSession exposed no current-session binding',
  'src/main.ts',
])
uiSessionShape = 'adapter'
rightClick(treeRow('file', `${WORKSPACE}/src/main.ts`).name)
deepEqual('and the current seam works again afterwards', menuLabels(), ['添加到对话', '复制路径'])

// Every gesture so far resolved its services through `get`; a direct property
// read of `sessions` or `uiSession` would have thrown in the proxy above, which
// is precisely the mistake that once made every request answer HTTP 400.
deepEqual('no service is ever read as an undeclared context property', [...new Set(directReads)].sort(), [
  'effect',
  'get',
  'slots',
])

// ── menu placement and dismissal ───────────────────────────────────────────

rightClick(fileRow.name, 1190, 780)
const placed = openMenuElement()
equal('a menu near the right edge is pulled inside the viewport', placed?.style.left, '972px')
equal('a menu near the bottom edge is pulled inside the viewport', placed?.style.top, '748px')

fireEvent(placed, 'pointerdown', {})
check('a pointerdown inside the menu does not dismiss it', openMenuElement() !== null)
const outside = new FakeElement('div')
fakeDocument.body.append(outside)
fireEvent(outside, 'pointerdown', {})
equal('a pointerdown outside the menu dismisses it', openMenuElement(), null)
equal('menu listeners are released on dismissal', fakeWindow.listeners.count('pointerdown'), 0)

rightClick(fileRow.name)
fireEvent(fakeWindow, 'keydown', { key: 'Escape' })
equal('Escape dismisses the menu', openMenuElement(), null)

// The window's own blur still closes the menu — that is the case worth keeping.
rightClick(fileRow.name)
fireEvent(fakeWindow, 'blur', {})
equal("the window's own blur dismisses the menu", openMenuElement(), null)

// …but a descendant's blur must not, or the click never happens. This is the
// regression guard for the bug that killed both rows: the listener must not be
// registered in the capture phase at all.
rightClick(fileRow.name)
equal('window blur dismissal is not in the capture phase', fakeWindow.listeners.countPhase('blur', true), 0)
fireEvent(fileRow.name, 'blur', {})
check("a descendant's blur leaves the menu standing", openMenuElement() !== null)
fireEvent(outside, 'pointerdown', {})

// ── the built-in preview selection ─────────────────────────────────────────

const ADDRESS = 'dsh-resource://file/session/s1/src/client/index.ts'

/**
 * Build the preview subtree the plugin reads, and one row per line number.
 * @param address - the address the preview publishes.
 * @returns the body, its line rows, and a descendant to right-click.
 */
function previewFrame(address) {
  const frame = new FakeElement('div')
  frame.setAttribute('data-textpreview-url', address)
  const body = new FakeElement('div')
  body.setAttribute('data-textpreview-body', 'true')
  frame.append(body)
  const lines = new Map()
  for (const number of [5, 6, 7, 8]) {
    const line = new FakeElement('div')
    line.setAttribute('data-textpreview-line', String(number))
    body.append(line)
    lines.set(number, line)
  }
  const inside = new FakeElement('span')
  body.append(inside)
  fakeDocument.body.append(frame)
  return { body, lines, inside }
}

const preview = previewFrame(ADDRESS)

/**
 * Select from one line row to another, the way a drag would.
 * @param from - the line the drag started on.
 * @param to - the line it ended on.
 * @param endOffset - the range's end offset inside the final line.
 */
function selectLines(from, to, endOffset = 3) {
  currentSelection = {
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => ({ startContainer: from, endContainer: to, endOffset }),
  }
  fireEvent(fakeDocument, 'selectionchange', {})
}

// The preview assertions below read each write whole, so the draft starts clean.
primary.state.draft = ''
primary.state.writes.length = 0

selectLines(preview.lines.get(5), preview.lines.get(7))
rightClick(preview.inside)
deepEqual('a preview selection names the line span', menuLabels(), ['添加到对话（第 5-7 行）', '复制路径'])
deepEqual('the preview row renders path:start-end', menuRefs(), ['src/client/index.ts:5-7', 'src/client/index.ts'])
clickRow('添加到对话（第 5-7 行）')
equal('the line range reaches the draft', primary.state.writes.at(-1), 'src/client/index.ts:5-7')

// A drag that stops at the very start of a line selected nothing on it.
selectLines(preview.lines.get(5), preview.lines.get(7), 0)
rightClick(preview.inside)
deepEqual('a drag ending at offset 0 drops the untouched line', menuRefs(), ['src/client/index.ts:5-6', 'src/client/index.ts'])

// One line reads as one line, not a range.
selectLines(preview.lines.get(6), preview.lines.get(6), 2)
rightClick(preview.inside)
deepEqual('a single-line selection uses the singular wording', menuLabels(), ['添加到对话（第 6 行）', '复制路径'])
deepEqual('a single-line selection renders path:N', menuRefs(), ['src/client/index.ts:6', 'src/client/index.ts'])

// No live selection: the preview path references the whole file, because a
// right-click inside the preview keeps its selection alive — a collapsed one
// means the reader is pointing at the file, not at a stale range.
currentSelection = null
rightClick(preview.inside)
deepEqual('a preview without a live selection references the whole file', menuRefs(), ['src/client/index.ts', 'src/client/index.ts'])

// A right-click that is neither a tree row nor a preview is left to the app.
const stray = new FakeElement('div')
fakeDocument.body.append(stray)
check('an unrelated right-click is not claimed', rightClick(stray) === false)
equal('an unrelated right-click closes the previous menu', openMenuElement(), null)

// ── the tab actions menu entry ─────────────────────────────────────────────

/**
 * Render this plugin's tab-menu entry for one tab.
 * @param tab - the tab record the dockkit menu hands over.
 * @param overrides - props to replace, for the degraded cases.
 * @returns the element (or null) and a dismissal counter.
 */
function renderMenuEntry(tab, overrides = {}) {
  let dismissed = 0
  const element = menuRegistration.Component({
    tab,
    dismiss: () => {
      dismissed += 1
    },
    inputActions: primary.binding.props.inputActions,
    useInput: (selector) => selector({ draft: primary.state.draft }),
    useSessions: (selector) => selector({ byId: { s1: { cwd: WORKSPACE } } }),
    sessionId: 's1',
    ...overrides,
  })
  return { element, dismissed: () => dismissed }
}

selectLines(preview.lines.get(5), preview.lines.get(7))
primary.state.draft = ''
primary.state.writes.length = 0
const withSelection = renderMenuEntry({ kind: 'text', contentId: ADDRESS })
deepEqual('the tab entry offers the selected range', [
  textOf(withSelection.element.children[0]),
  textOf(withSelection.element.children[1]),
], ['添加到对话（第 5-7 行）', 'src/client/index.ts:5-7'])
check('the tab entry is a menu row', withSelection.element.type === 'button' && withSelection.element.props.role === 'menuitem')
check('the tab entry shares the body menu row class', withSelection.element.props.className === 'dfs-item')
withSelection.element.props.onClick()
equal('the tab entry dismisses the dockkit menu', withSelection.dismissed(), 1)
equal('the tab entry appends the range', primary.state.writes.at(-1), 'src/client/index.ts:5-7')

// A tab that is not a file gets no entry at all.
currentSelection = null
equal(
  'the files tree tab offers nothing',
  renderMenuEntry({ kind: 'files', contentId: 'dsh-resource://page/@deepseek-ai/dsh-client-ui-sidebar-files' }).element,
  null,
)
equal('the guide tab offers nothing', renderMenuEntry({ kind: 'guide', contentId: 'dsh-resource://page/guide' }).element, null)

// The live selection is gone, but the remembered one still belongs to this
// document, so the tab entry keeps offering it — that memory is the whole
// reason the tab gesture can reference a line range at all.
const rememberedTab = renderMenuEntry({ kind: 'text', contentId: ADDRESS })
deepEqual('a tab keeps the remembered range for its own document', [
  textOf(rememberedTab.element.children[0]),
  textOf(rememberedTab.element.children[1]),
], ['添加到对话（第 5-7 行）', 'src/client/index.ts:5-7'])

// A selection remembered for a different document must not leak into this one.
const otherDocument = renderMenuEntry({ kind: 'text', contentId: 'dsh-resource://file/session/s1/README.md' })
deepEqual('a selection made in another document is not reused', [
  textOf(otherDocument.element.children[0]),
  textOf(otherDocument.element.children[1]),
], ['添加到对话', 'README.md'])

// The entry hides itself — and says so in the log — when the provider a future
// version might stop offering is absent, rather than rendering a dead row.
const withoutHooks = renderMenuEntry({ kind: 'text', contentId: ADDRESS }, { inputActions: undefined })
equal('the tab entry renders nothing without the draft tools', withoutHooks.element, null)
check(
  'and reports the degraded capability in the log',
  warnings.some((line) => line.includes('got no inputActions.setDraft')),
)

// ── the draft is only ever extended, never sent ────────────────────────────

check('the client bundle never submits', /\.submit\s*\(/.test(clientSource) === false)
check('the client bundle never calls inputActions.submit', /inputActions\s*\.\s*submit\s*\(/.test(clientSource) === false)

// ── the host half is inert ─────────────────────────────────────────────────

const hostSource = await readFile(join(root, 'lib/index.js'), 'utf8')
const host = await import(new URL('../lib/index.js', import.meta.url))
equal('the host half keeps the package name', host.name, pkg.name)
deepEqual('the host half requires no service', host.inject, [])
check('the host half is a function', typeof host.apply === 'function')
check('the host half registers no web route', hostSource.includes('webServer') === false)
check('the host half reads no file', hostSource.includes('node:fs') === false)

// ── packaging ──────────────────────────────────────────────────────────────

const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
check('the bundle patch inserts the row by package name', patch.includes(`name: '${pkg.name}'`))
check('the bundle patch carries no host config', patch.includes('config:') === false)
equal('package.json points main at the host half', pkg.main, 'lib/index.js')
equal('package.json declares the web platform', pkg.dsh?.client?.platform, 'web')
equal('package.json ships its bundle patch', pkg.dsh?.bundle?.patch, './cordis.patch.yml')

// ── report ─────────────────────────────────────────────────────────────────

report()
