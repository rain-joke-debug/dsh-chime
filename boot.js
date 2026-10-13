/**
 * DSH Turn Chime — Loader entry point.
 *
 * Same trick the whale pet uses: the real code lives in `impl.js` and is
 * imported with a cache-busting timestamp, because the Loader keeps the first
 * module generation for the life of the process. Without this indirection,
 * every edit would need a full DSH restart; with it, disabling and enabling
 * the plugin is enough.
 *
 * @module dsh-chime
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** We only listen to session events, so the session service must exist. */
export const inject = ['sessions']

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Import the current implementation generation and run it.
 *
 * @param ctx - host plugin context.
 * @param config - the Loader row's `config`.
 */
export async function apply(ctx, config) {
  const url = `${pathToFileURL(join(here, 'impl.js')).href}?t=${Date.now()}`
  const impl = await import(url)
  await impl.apply(ctx, config)
}
