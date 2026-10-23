/**
 * dsh-file-selector — host half.
 *
 * The plugin is deliberately **client-only in effect**: since DSH 0.1.5-rc.2
 * ships the workspace file browser and the document preview, and a draft
 * reference is nothing but a path (or `path:start-end`), nothing has to be read
 * on the host. The browser resolves every path through the built-in
 * `workspaceFiles` Remote namespace, which the preview already uses.
 *
 * This module therefore exists to keep the package a valid bundle row — the
 * row's `main` is loaded by the host loader, and the same row is what composes
 * the browser bundle from `dsh.client.platform`. It declares no services and
 * registers no route, so it cannot fail a request.
 */

/** Cordis plugin name; must match the package name the patch row resolves. */
export const name = 'dsh-file-selector'

/** No host services are required. */
export const inject: string[] = []

/**
 * Load the host half.
 *
 * Registered so the bundle row is valid and the log records which half is live;
 * every capability lives in the browser half.
 */
export function apply(): void {
  console.log('[dsh-file-selector] host half loaded — selection is client-side; no host surface')
}
