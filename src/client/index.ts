/**
 * dsh-file-selector — browser half.
 *
 * DSH 0.1.5-rc.2 ships its own workspace file browser
 * (`@deepseek-ai/dsh-client-ui-sidebar-files`) and document preview
 * (`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`), so this plugin no
 * longer draws a tree, a preview, a drawer or a host route. It contributes only
 * the one thing those surfaces do not have: **putting a file, or a selected
 * range of one, into the composer draft**.
 *
 * Three surfaces, two mechanisms:
 *
 *  1. `sidebar.right.tab.menu.item` — a documented `list` slot at `session`
 *     scope ("Extra items at the end of one tab's actions menu"). Right-
 *     clicking a preview tab offers the document's path, or `path:start-end`
 *     when text is selected in that preview. The slot hands occupants `tab`,
 *     `dismiss`, and the standard `inputActions` / `useInput` / `useSessions` /
 *     `sessionId` props, so this row writes the draft through props alone.
 *  2. Two delegated `contextmenu` handlers for the gestures the built-in
 *     surfaces leave to the browser: a file-tree row (path only — selecting a
 *     file without opening it) and a preview text selection (the line range).
 *     Both read the built-in DOM hooks (`data-files-entry`, `data-files-path`,
 *     `data-files-root`, `data-textpreview-url`, `data-textpreview-body`,
 *     `data-textpreview-line`), which are the same attributes the harness's own
 *     `scrollToLine` navigates by.
 *
 * Those delegated handlers run outside React, so they need the draft tools
 * without a component. They ask the framework's own provide channel for them
 * (`uiSession.resolve(sessionId)` — the `{ hooks, props }` bundle that slot
 * occupants are handed), resolved **per gesture for the current session**. An
 * earlier revision published the tools from a `conversation.composer.dock`
 * occupant instead, which was wrong twice over: the composer renders that slot
 * only when it has an extension zone (so the menus went dead whenever the zone
 * was absent), and "whichever occupant rendered last" is not necessarily the
 * session the reader is pointing at.
 *
 * The draft is only ever *replaced with an appended value*: `inputActions.submit`
 * is never called, so nothing is ever sent. Only the reference is written — no
 * file content crosses into the conversation.
 *
 * Written inside the module-loader factory: `require` reaches the shell's frozen
 * module table, so `react` is the only module this bundle asks for.
 */

/** What one delegated menu can offer, in display order. */
interface MenuAction {
  /** Row text, already localized. */
  label: string
  /** Mono reference shown after the label and used as the row's tooltip. */
  ref?: string
  /** Shown but not offered: a state report rather than an affordance. */
  disabled?: boolean
  /** Run after the menu is dismissed. */
  run?: () => void
}

/**
 * The draft tools one gesture needs.
 *
 * `setDraft` is the conversation shell's public provide-channel action face
 * (`{ setDraft, addAttachments, removeAttachment, pruneAttachments, submit }`);
 * only `setDraft` is used here, and `submit` deliberately is not.
 */
interface DraftTools {
  /** Session the tools belong to. */
  sessionId: string
  /** The draft as of this gesture. */
  draft: string
  /** That session's workspace root, when the session list knows it. */
  cwd: string | undefined
  /** Replace the whole draft. */
  setDraft: (text: string) => void
  /** Re-read the draft, so a write can be confirmed to have landed. */
  readDraft?: () => string | undefined
}

/** A reference resolved from a DOM surface, before line information is attached. */
interface PreviewSelection {
  /** `dsh-resource://file/session/…` address the selection was made in. */
  address: string
  /** First selected source line, 1-based. */
  start: number
  /** Last selected source line, 1-based. */
  end: number
}
/**
 * Build the client plugin.
 *
 * @param require - the bundle factory's CommonJS `require`, answering only from
 *   the shell's frozen module table.
 * @returns the Cordis plugin face: `apply` plus the injected service names.
 */
function createDshFileSelector(require: (id: string) => any): {
  apply: (ctx: any) => void
  inject: string[]
} {
  const React = require('react')
  const h = React.createElement

  // ── file addresses ───────────────────────────────────────────────────────
  //
  // The right sidebar addresses resources as
  // `dsh-resource://file/session/<sessionId>/<workspace-relative path>`: the
  // preview's `data-textpreview-url` and a tab's `contentId` are both that
  // address, and a path inside the workspace has already been made relative to
  // it by `fileAddressFor`. Decoding it is therefore the cheapest way to learn
  // which file a preview is showing.

  const ADDRESS_PREFIX = 'dsh-resource://file/session/'

  /** Decode one address segment, tolerating a malformed one. */
  function decodeSegment(segment: string): string {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  }

  /**
   * Split a resource address into the session and the path it names.
   *
   * @param address - the `dsh-resource://file/session/…` address to read.
   * @returns the parts, or `null` for anything that is not a file address (a
   *   synthetic page tab, the guide, a non-resource tab, a tab with no value).
   */
  function fileFromAddress(address: unknown): { sessionId: string; path: string } | null {
    if (typeof address !== 'string' || !address.startsWith(ADDRESS_PREFIX)) return null
    const rest = address.slice(ADDRESS_PREFIX.length)
    const cut = rest.indexOf('/')
    if (cut < 0) return null
    const path = rest
      .slice(cut + 1)
      .split('/')
      .map(decodeSegment)
      .join('/')
    if (path === '' || path.endsWith('/')) return null
    return { sessionId: decodeSegment(rest.slice(0, cut)), path }
  }

  /**
   * Shorten an absolute path against a workspace root.
   *
   * The tree's rows carry absolute paths while the preview's address carries a
   * workspace-relative one, and a draft reference should read the same either
   * way. A path already relative, or outside the root, is returned as-is.
   *
   * @param path - absolute or relative path in either separator spelling.
   * @param root - the workspace root, when known.
   * @returns the workspace-relative path where possible.
   */
  function workspaceRelative(path: string, root: string | undefined): string {
    const normalized = path.replace(/\\/g, '/')
    if (typeof root !== 'string' || root === '') return normalized
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
    if (base === '') return normalized
    const prefix = `${base}/`
    // Windows roots differ in case from what a picker returns; compare folded,
    // slice on the original so the remainder keeps its own spelling.
    if (normalized.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) return normalized.slice(prefix.length)
    return normalized
  }

  /**
   * Render one reference the way a draft should read it.
   *
   * @param path - workspace-relative path.
   * @param start - first line, or `null` for a whole-file reference.
   * @param end - last line, or `null` for a whole-file reference.
   * @returns `path`, `path:N` or `path:N-M`.
   */
  function referenceText(path: string, start: number | null, end: number | null): string {
    if (start === null || end === null) return path
    return start === end ? `${path}:${start}` : `${path}:${start}-${end}`
  }

  // ── draft tools, straight from the framework ─────────────────────────────

  /** Distinct diagnostics already emitted, so each reason is reported once. */
  const warned = new Set<string>()

  /**
   * Report a degraded capability once per reason per page.
   *
   * The alternative — rendering an affordance that cannot act — is the failure
   * this plugin was written to remove, so a missing provider is reported here
   * and the surface either hides or explains itself.
   */
  function warnOnce(message: string): void {
    if (warned.has(message)) return
    warned.add(message)
    console.warn(`[dsh-file-selector] ${message}`)
  }

  /**
   * Show a short-lived notice, and record it in the console.
   *
   * The browser console does not reach the harness log, so a failure that only
   * logs is a failure nobody can see. Anything the reader would otherwise
   * experience as "nothing happened" goes here instead.
   */
  let noticeElement: HTMLElement | null = null
  let noticeTimer: any = null

  function notice(text: string): void {
    warnOnce(text)
    if (typeof document === 'undefined') return
    if (noticeElement !== null) noticeElement.remove()
    const element = document.createElement('div')
    element.className = 'dfs-notice'
    element.setAttribute('role', 'status')
    element.textContent = `引用未生效：${text}`
    document.body.append(element)
    noticeElement = element
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      element.remove()
      if (noticeElement === element) noticeElement = null
      noticeTimer = null
    }, 6000)
    // Never hold a process open for a toast (browsers return a number here).
    if (noticeTimer !== null && typeof noticeTimer.unref === 'function') noticeTimer.unref()
  }

  /**
   * The current session's standard-source binding:
   * `{ key, ctx, hooks, keyedHooks, props }`.
   *
   * The harness has already moved this seam once. 0.1.5-rc.2 exposed
   * `uiSession.resolve(sessionId)`; 0.1.7 replaced it with
   * `uiSession.adapter.current`, the very source the right sidebar itself reads
   * (`ctx.uiSession.adapter.current.getSnapshot().key`). Newest shape first, so
   * the next move degrades into the reported reason instead of a silent no-op.
   *
   * @param uiSession - the `uiSession` service, when present.
   * @param list - the session list snapshot, which the older shape needs.
   * @returns the binding and which accessor produced it, or a null binding.
   */
  function currentBinding(uiSession: any, list: any): { binding: any; via: string } {
    const source = uiSession?.adapter?.current
    if (source !== undefined && source !== null) {
      const value = typeof source.getSnapshot === 'function' ? source.getSnapshot() : source.value
      if (value !== undefined && value !== null) return { binding: value, via: 'uiSession.adapter.current' }
    }
    if (typeof uiSession?.resolve === 'function') {
      // 0.1.5-rc.2 took a session id, which that version's list published as
      // `current` (0.1.7 publishes no such field — the binding's own `key` is
      // the only session identity left, which is why this path is second).
      const id = typeof list?.current === 'string' ? list.current : undefined
      if (id !== undefined) {
        const value = uiSession.resolve(id)
        if (value !== undefined && value !== null) return { binding: value, via: 'uiSession.resolve' }
      }
    }
    return { binding: null, via: '' }
  }

  /**
   * Resolve the draft tools for the session the reader is currently in.
   *
   * Services are read with `ctx.get` rather than as context properties: this
   * runs on a user gesture, and a plugin that declares `sessions`/`uiSession`
   * in `inject` would simply never activate in a composition that lacks them.
   * `get` is the documented read-without-the-inject-requirement path, so a
   * missing service degrades to an explained row instead of either throwing
   * mid-gesture or blocking activation.
   *
   * The session identity comes from the **binding**, not from the session list:
   * 0.1.7 stopped publishing `list.current`, and the binding is what the app's
   * own sidebar reads. The reason names the seam that failed, because that
   * message is the only thing that turns an upgrade break into a one-line
   * diagnosis.
   *
   * @param ctx - the client plugin context captured by `apply`.
   * @returns the tools, or the reason they are unavailable.
   */
  function resolveTools(ctx: any): { tools: DraftTools | null; reason: string } {
    const uiSession = ctx.get?.('uiSession')
    const list = ctx.get?.('sessions')?.list?.getSnapshot?.()
    const { binding, via } = currentBinding(uiSession, list)
    if (binding === null) return { tools: null, reason: 'uiSession exposed no current-session binding' }
    const sessionId = typeof binding.key === 'string' ? binding.key : undefined
    if (sessionId === undefined) return { tools: null, reason: `the binding via ${via} carries no session key` }
    const setDraft = binding.props?.inputActions?.setDraft
    if (typeof setDraft !== 'function') {
      return { tools: null, reason: `the input action face carries no setDraft (via ${via})` }
    }
    const input = binding.hooks?.input
    const readDraft =
      typeof input?.getSnapshot === 'function'
        ? () => {
            const state = input.getSnapshot()
            return typeof state?.draft === 'string' ? state.draft : undefined
          }
        : undefined
    const cwd = list?.byId?.[sessionId]?.cwd
    return {
      tools: { sessionId, draft: readDraft?.() ?? '', cwd, setDraft, readDraft },
      reason: '',
    }
  }

  /**
   * Append one reference as its own line of the composer draft.
   *
   * The write is confirmed by re-reading the same store, because a write that
   * silently does not land is indistinguishable from a click that never
   * happened — and that ambiguity has already cost this plugin two rounds.
   *
   * @param tools - the resolved draft tools.
   * @param text - the reference to append.
   * @returns whether the draft is now known to hold the reference.
   */
  function appendReference(tools: DraftTools | null, text: string): boolean {
    if (tools === null || typeof tools.setDraft !== 'function') return false
    const current = typeof tools.draft === 'string' ? tools.draft : ''
    const kept = current.replace(/[\s\u00a0]+$/u, '')
    const next = kept === '' ? text : `${kept}\n${text}`
    try {
      tools.setDraft(next)
    } catch (error) {
      notice(`添加到对话抛错：${String(error)}`)
      return false
    }
    const after = tools.readDraft?.()
    if (after !== undefined && after !== next) {
      notice(`添加到对话没有落到草稿上（草稿仍是 ${JSON.stringify(after.slice(0, 40))}）`)
      return false
    }
    return true
  }

  /**
   * Write text to the clipboard.
   *
   * The async Clipboard API is the primary path, but it can still refuse (a
   * document without focus, a permission policy), so a refused write falls back
   * to the selection-based command — and if even that fails, the failure is
   * *reported*. Swallowing the rejection is what made "nothing happened" the
   * only symptom available for a refused copy.
   */
  function copyText(text: string): void {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
      Promise.resolve(clipboard.writeText(text)).then(undefined, (error: unknown) => {
        if (copyViaSelection(text)) return
        notice(`复制路径失败：${String(error)}`)
      })
      return
    }
    if (copyViaSelection(text)) return
    notice('复制路径失败：没有剪贴板接口，也没有 select 回退')
  }

  /**
   * Copy through a temporary selection: the one path left when the async
   * clipboard refuses, and the reason this never depends on a permission.
   *
   * @param text - the text to copy.
   * @returns whether the command reported success.
   */
  function copyViaSelection(text: string): boolean {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.append(area)
    let copied = false
    try {
      area.select()
      copied = document.execCommand('copy') === true
    } catch {
      copied = false
    }
    area.remove()
    return copied
  }

  // ── preview selection ────────────────────────────────────────────────────
  //
  // The preview renderer swaps its body per file type: a plain-text body draws
  // one `[data-textpreview-line="N"]` row per source line, while the
  // highlighted code body delegates to the primitives' CodeBlock and draws
  // `pre .line` rows instead. The harness's own `scrollToLine` resolves both the
  // same way, and so does `lineOf`.

  /** The element a selection endpoint sits in, whichever node kind it is. */
  function elementOf(node: Node | null): Element | null {
    if (node === null) return null
    if (node.nodeType === 1) return node as Element
    if (node.nodeType === 3) return (node as Text).parentElement
    return null
  }

  /**
   * Resolve the 1-based source line one selection endpoint sits on.
   *
   * @param node - the range endpoint's container.
   * @param body - the preview's scrolling body, the query root for code rows.
   * @returns the line number, or `null` when this body exposes none.
   */
  function lineOf(node: Node | null, body: Element): number | null {
    const element = elementOf(node)
    if (element === null) return null
    const marked = element.closest('[data-textpreview-line]')
    if (marked !== null) {
      const line = Number(marked.getAttribute('data-textpreview-line'))
      return Number.isFinite(line) ? line : null
    }
    const row = element.closest('pre .line')
    if (row === null) return null
    const rows = body.querySelectorAll('pre .line')
    const index = Array.prototype.indexOf.call(rows, row)
    return index < 0 ? null : index + 1
  }

  /**
   * Read the live text selection, when it is a range inside one preview body.
   *
   * @returns the address and line span, or `null` for a collapsed selection, a
   *   selection outside a preview, or a body that exposes no line rows
   *   (markdown, images, PDFs).
   */
  function readSelection(): PreviewSelection | null {
    if (typeof window === 'undefined') return null
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
    const range = selection.getRangeAt(0)
    const body = elementOf(range.startContainer)?.closest('[data-textpreview-body]')
    if (body === undefined || body === null) return null
    if (body !== elementOf(range.endContainer)?.closest('[data-textpreview-body]')) return null
    const address = body.closest('[data-textpreview-url]')?.getAttribute('data-textpreview-url')
    if (address === undefined || address === null || address === '') return null
    const start = lineOf(range.startContainer, body)
    let end = lineOf(range.endContainer, body)
    if (start === null || end === null) return null
    // A drag that stops at the very start of a line selected nothing on that
    // line, so the range really ends on the one before it.
    if (end > start && range.endOffset === 0) end -= 1
    return { address, start, end }
  }

  /**
   * The last selection seen inside a preview, kept because the gesture that
   * asks for a range is a right-click on the preview's *tab* — which collapses
   * the DOM selection before any handler of ours runs.
   */
  const remembered: { address: string | null; start: number | null; end: number | null } = {
    address: null,
    start: null,
    end: null,
  }

  /** Track the live selection; the tab menu reads the last one that survived. */
  function rememberSelection(): void {
    const found = readSelection()
    if (found === null) return
    remembered.address = found.address
    remembered.start = found.start
    remembered.end = found.end
  }

  /**
   * The line span to use for one document.
   *
   * @param address - the document the caller is about to reference.
   * @param allowRemembered - whether the remembered selection may stand in.
   *   Only the tab menu needs that: right-clicking a tab collapses the DOM
   *   selection, so its gesture destroys the very thing it wants to reference.
   *   A right-click inside the preview keeps the selection alive, so that path
   *   asks for the live one only — and a right-click elsewhere in the preview
   *   then means the whole file rather than a stale range.
   * @returns the span, or `null` when nothing applies to this document.
   */
  function spanFor(address: string, allowRemembered: boolean): { start: number; end: number } | null {
    const current = readSelection()
    if (current !== null && current.address === address) return { start: current.start, end: current.end }
    if (!allowRemembered) return null
    if (remembered.address === address && remembered.start !== null && remembered.end !== null) {
      return { start: remembered.start, end: remembered.end }
    }
    return null
  }

  /** Human wording for one span. */
  function spanLabel(span: { start: number; end: number } | null): string {
    if (span === null) return '添加到对话'
    return span.start === span.end
      ? `添加到对话（第 ${span.start} 行）`
      : `添加到对话（第 ${span.start}-${span.end} 行）`
  }

  // ── stylesheet ───────────────────────────────────────────────────────────
  //
  // Two menus show these rows: our own body-level menu, and this plugin's entry
  // inside the dockkit tab menu (which renders our React row into its own card).
  // Both therefore share one row class, styled to the harness Menu cell
  // (min-height 40, r10, pad 10/8, 14/22) so the entry is indistinguishable
  // from the card's own rows.

  const STYLE_ID = 'dsh-file-selector/menu.css'
  const STYLE_TEXT = [
    '.dfs-menu{position:fixed;z-index:1200;box-sizing:border-box;min-width:218px;max-width:360px;padding:4px;display:flex;flex-direction:column;border-radius:20px;',
    'background:var(--dsw-specific-menu,var(--dsw-alias-bg-base,Canvas));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.24));',
    '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}',
    '.dfs-item{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:40px;padding:8px 10px;border:0;border-radius:10px;',
    'background:transparent;color:var(--dsw-alias-label-primary,CanvasText);font-family:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}',
    '.dfs-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
    '.dfs-item-disabled{color:var(--dsw-alias-label-tertiary,GrayText);cursor:default}',
    '.dfs-item-disabled:hover{background:transparent}',
    '.dfs-item-label{flex:none}',
    '.dfs-item-ref{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,GrayText);font-size:12px}',
    '.dfs-notice{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1300;box-sizing:border-box;max-width:min(560px,90vw);',
    'padding:8px 14px;border-radius:12px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-2,#3a3a3a));color:var(--dsw-alias-label-primary,#fff);',
    'font-size:13px;line-height:20px;box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.24))}',
  ].join('')

  /** Inject the row/menu stylesheet once per document. */
  function installStyles(): void {
    if (typeof document === 'undefined') return
    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-file-selector'
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = STYLE_TEXT
    document.head.append(tag)
  }

  // ── body-level menu ──────────────────────────────────────────────────────
  //
  // Hand-built rather than routed through a React root: the delegated handlers
  // run outside the component tree, and a fixed, self-dismissing element is
  // less machinery than mounting a second root for a transient menu.

  /** Tear down the open menu, if any. */
  let closeMenu: (() => void) | null = null

  /** Close the open menu (idempotent). */
  function dismissMenu(): void {
    const dispose = closeMenu
    if (dispose === null) return
    closeMenu = null
    dispose()
  }

  /**
   * Show one menu at a pointer position.
   *
   * @param x - pointer client X.
   * @param y - pointer client Y.
   * @param actions - the rows to offer, in order.
   */
  function openMenu(x: number, y: number, actions: MenuAction[]): void {
    if (typeof document === 'undefined' || actions.length === 0) return
    dismissMenu()
    const root = document.createElement('div')
    root.className = 'dfs-menu'
    root.setAttribute('role', 'menu')
    for (const action of actions) {
      const inert = action.disabled === true
      const row = document.createElement(inert ? 'div' : 'button')
      row.className = inert ? 'dfs-item dfs-item-disabled' : 'dfs-item'
      row.setAttribute('role', 'menuitem')
      if (inert) {
        // A state report, not a control: it says why the action is missing
        // rather than pretending to be one.
        row.setAttribute('aria-disabled', 'true')
      } else {
        ;(row as HTMLButtonElement).type = 'button'
      }
      const label = document.createElement('span')
      label.className = 'dfs-item-label'
      label.textContent = action.label
      row.append(label)
      if (action.ref !== undefined) {
        row.title = action.ref
        const ref = document.createElement('span')
        ref.className = 'dfs-item-ref'
        ref.textContent = action.ref
        row.append(ref)
      }
      if (!inert && typeof action.run === 'function') {
        const run = action.run
        // Dismiss first: the row's action may replace what the menu floats over.
        row.addEventListener('click', () => {
          dismissMenu()
          run()
        })
      }
      root.append(row)
    }
    document.body.append(root)

    const rect = root.getBoundingClientRect()
    const margin = 8
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))
    const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))
    root.style.left = `${Math.round(left)}px`
    root.style.top = `${Math.round(top)}px`

    const onPointerDown = (event: Event): void => {
      if (event.target instanceof Node && root.contains(event.target)) return
      dismissMenu()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismissMenu()
    }
    // Any scroll or resize invalidates the pointer-anchored position.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', dismissMenu, true)
    window.addEventListener('resize', dismissMenu, true)
    // NOT in the capture phase. `blur` does not bubble, so only a *capturing*
    // window listener sees a descendant's blur — and clicking a row is itself a
    // focus transition: the composer's editor blurs, this handler tears the menu
    // down, the row leaves the document, `mouseup` lands on nothing, and the
    // `click` that would have run the action is never dispatched at all. That is
    // how both rows went dead while looking perfectly healthy. A plain listener
    // still catches the window's own blur, which is the case worth closing on.
    window.addEventListener('blur', dismissMenu)

    closeMenu = () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', dismissMenu, true)
      window.removeEventListener('resize', dismissMenu, true)
      window.removeEventListener('blur', dismissMenu)
      root.remove()
    }
  }

  // ── delegated gestures ───────────────────────────────────────────────────

  /**
   * The rows for one reference, plus — when the draft cannot be written — a row
   * that *says so*.
   *
   * After two rounds of "the menu appeared but nothing was added", the reason
   * belongs on screen rather than in a console the reader has to open. A
   * working install shows the two real rows and nothing else.
   *
   * @param reference - what the add row would append.
   * @param label - the add row's wording (it names the line range when there is one).
   * @param path - the plain path the copy row writes.
   * @param tools - the draft tools, or `null` when they could not be resolved.
   * @param reason - why they could not be resolved.
   * @returns the rows, in order.
   */
  function referenceActions(
    reference: string,
    label: string,
    path: string,
    tools: DraftTools | null,
    reason: string,
  ): MenuAction[] {
    if (tools === null) {
      warnOnce(`add-to-conversation unavailable: ${reason}`)
      return [
        { label: '添加到对话不可用', ref: reason, disabled: true },
        { label: '复制路径', ref: path, run: () => copyText(path) },
      ]
    }
    return [
      { label, ref: reference, run: () => appendReference(tools, reference) },
      { label: '复制路径', ref: path, run: () => copyText(path) },
    ]
  }

  /**
   * The workspace root a tree row belongs to.
   *
   * Read from the tree's own `data-files-root` rather than from the session, so
   * the reference is relative to the very root the reader is looking at.
   *
   * @param row - the built-in tree row element.
   * @param tools - the draft tools, whose session cwd is the fallback.
   * @returns the root, when either source knows it.
   */
  function rootForRow(row: Element, tools: DraftTools | null): string | undefined {
    const declared = row.closest('[data-files-root]')?.getAttribute('data-files-root')
    if (declared !== null && declared !== undefined && declared !== '') return declared
    return tools?.cwd
  }

  /**
   * A right-click on a built-in file-tree row or inside a preview.
   *
   * The row is the `li` carrying `data-files-entry` and its absolute
   * `data-files-path`; the pane header reuses the `data-files-path` *name* with a
   * boolean value, so the entry attribute is what identifies a row.
   *
   * @param ctx - the client plugin context.
   * @param event - the contextmenu event.
   */
  function onContextMenu(ctx: any, event: MouseEvent): void {
    // Any context menu replaces whatever the last one left floating; an
    // unhandled right-click still dismisses ours so the app's own menu (or the
    // native one) is not drawn under a stale card of ours.
    dismissMenu()
    const target = event.target
    if (!(target instanceof Element)) return

    const row = target.closest('[data-files-entry]')
    if (row !== null) {
      const absolute = row.getAttribute('data-files-path')
      if (absolute === null || absolute === '' || absolute === 'true') return
      event.preventDefault()
      // Resolved only once the gesture is ours: an unrelated right-click must
      // not touch services at all.
      const { tools, reason } = resolveTools(ctx)
      const path = workspaceRelative(absolute, rootForRow(row, tools))
      openMenu(event.clientX, event.clientY, referenceActions(path, '添加到对话', path, tools, reason))
      return
    }

    const body = target.closest('[data-textpreview-body]')
    if (body === null) return
    const address = body.closest('[data-textpreview-url]')?.getAttribute('data-textpreview-url')
    const file = fileFromAddress(address)
    if (file === null) return
    event.preventDefault()
    const { tools, reason } = resolveTools(ctx)
    // The preview's address is already workspace-relative; the session's cwd is
    // only a guard for an address that kept an absolute path.
    const path = workspaceRelative(file.path, tools?.cwd)
    const span = spanFor(String(address), false)
    const reference = referenceText(path, span?.start ?? null, span?.end ?? null)
    openMenu(event.clientX, event.clientY, referenceActions(reference, spanLabel(span), path, tools, reason))
  }

  /** Whether the delegated listeners are attached. */
  let watching = false

  /** The context-menu handler bound to one context. */
  let contextMenuHandler: ((event: MouseEvent) => void) | null = null

  /**
   * Attach the selection tracker and the context-menu delegation.
   *
   * @param ctx - the client plugin context the handlers resolve services from.
   */
  function installGestures(ctx: any): void {
    if (watching || typeof document === 'undefined') return
    watching = true
    contextMenuHandler = (event: MouseEvent) => onContextMenu(ctx, event)
    // Capture phase: the built-in rows are React buttons and the app may own a
    // bubble-phase handler of its own, so claim the event before either runs.
    document.addEventListener('selectionchange', rememberSelection)
    document.addEventListener('contextmenu', contextMenuHandler, true)
  }

  /** Detach what {@link installGestures} attached. */
  function uninstallGestures(): void {
    if (!watching) return
    watching = false
    dismissMenu()
    document.removeEventListener('selectionchange', rememberSelection)
    if (contextMenuHandler !== null) document.removeEventListener('contextmenu', contextMenuHandler, true)
    contextMenuHandler = null
  }

  // ── slot occupant ────────────────────────────────────────────────────────

  /**
   * Call a provider hook defensively.
   *
   * The slot contract lists `useInput`/`useSessions` among a session-scoped
   * occupant's standard props, but they arrive through the harness's provide
   * channel: if a future version stops offering one, the row should degrade to
   * its unselected wording rather than throw inside the menu.
   */
  function useProvided<T>(hook: unknown, selector: (state: any) => unknown, fallback: T): T {
    if (typeof hook !== 'function') return fallback
    const value = (hook as (selector: (state: any) => unknown) => unknown)(selector)
    return value === undefined ? fallback : (value as T)
  }

  /**
   * This plugin's entry in one tab's actions menu.
   *
   * The slot is a `list` at `session` scope, so the occupant owns one row and
   * decides its own visibility: a tab whose `contentId` is not a file address
   * (the workspace guide, the files tree itself) renders nothing.
   */
  function AddToConversation(props: any): any {
    const { tab, dismiss, inputActions, useInput, useSessions, sessionId } = props
    const draft = useProvided<string>(useInput, (state: any) => state?.draft, '')
    const cwd = useProvided<string | undefined>(useSessions, (sessions: any) => sessions?.byId?.[sessionId]?.cwd, undefined)
    const setDraft = inputActions === undefined || inputActions === null ? undefined : inputActions.setDraft
    const file = fileFromAddress(tab === undefined || tab === null ? null : tab.contentId)
    if (file === null) return null
    // A tab that names a file but cannot write the draft gets no row: an
    // affordance that silently does nothing is worse than a missing one.
    if (typeof setDraft !== 'function') {
      warnOnce('the tab menu entry got no inputActions.setDraft; hiding the row')
      return null
    }
    const address = String(tab.contentId)
    const path = workspaceRelative(file.path, cwd)
    const span = spanFor(address, true)
    const ref = referenceText(path, span?.start ?? null, span?.end ?? null)
    return h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        className: 'dfs-item',
        title: ref,
        onClick: () => {
          // The menu is the dockkit's; an item that acts must dismiss it.
          if (typeof dismiss === 'function') dismiss()
          appendReference({ sessionId, draft, cwd, setDraft }, ref)
        },
      },
      h('span', { className: 'dfs-item-label' }, spanLabel(span)),
      h('span', { className: 'dfs-item-ref' }, ref),
    )
  }

  // ── registration ─────────────────────────────────────────────────────────

  /**
   * Register the tab-menu seat and the delegated gestures.
   *
   * @param ctx - the client plugin context.
   */
  function apply(ctx: any): void {
    installStyles()
    ctx.effect(() => {
      installGestures(ctx)
      return uninstallGestures
    }, 'dsh-file-selector: context menus')
    // `inject` waits for the owning declaration, so this survives the sidebar
    // being declared by a plugin that mounts after this one.
    ctx.effect(
      () =>
        ctx.slots.inject('sidebar.right.tab.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.menu.item',
              id: 'file-selector-add-to-conversation',
              order: 40,
            },
            AddToConversation,
          ),
        ),
      'dsh-file-selector: add to conversation',
    )
    console.log('[dsh-file-selector] client half loaded — tab menu + tree/preview context menus')
  }

  /** Cordis services required before `apply` runs. */
  const inject: string[] = ['slots']

  return { apply, inject }
}
