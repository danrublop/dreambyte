/**
 * Auto-update lifecycle for packaged builds.
 *
 * Runs only when `app.isPackaged === true`. In dev, `electron-updater` would
 * fail loudly against a dev-mode app and surface "Cannot find Squirrel" /
 * "This app is not installed via a release channel" warnings the first time
 * you open dev tools. Guarding saves that noise and matches the pattern we
 * use elsewhere (validateExportDeps, etc.).
 *
 * What lands in this file:
 *   - `initAutoUpdater(mainWindow)` — call once on app.whenReady after the
 *     main window exists. Silent background check + download; prompts the
 *     user to install on quit once a download lands.
 *   - `checkForUpdatesInteractive(mainWindow)` — wired to the "Check for
 *     Updates..." menu item. Shows a dialog for every outcome (already
 *     current, new version downloading, error) so the user gets explicit
 *     feedback when they explicitly ask.
 *
 * Publish target is configured in package.json > build.publish. Right now
 * that's a GitHub release channel (owner/repo baked in). electron-updater
 * reads it at runtime from app-update.yml bundled by electron-builder.
 *
 * Security note: the updater verifies code signatures on macOS (via hardened
 * runtime + notarization) and on Windows (via the EV cert). Until those certs
 * land, the updater will refuse to install anything — which is the correct
 * default. Enabling the flow before signing would just silently no-op.
 */

import { app, BrowserWindow, dialog } from 'electron'
import type { UpdateInfo } from 'electron-updater'
import { createLogger } from '../lib/logger'

const log = createLogger('electron.auto-updater')

let initialized = false
let interactiveCheckInFlight = false

async function loadUpdater(): Promise<typeof import('electron-updater').autoUpdater | null> {
  try {
    const mod = await import('electron-updater')
    return mod.autoUpdater
  } catch (err) {
    log.warn('electron-updater module failed to load', { error: err })
    return null
  }
}

/** Silent background check + download on boot. Never shows modal dialogs
 * unless an update is installed at quit — those are handled by the OS-level
 * installer. Call once per app launch. */
export async function initAutoUpdater(): Promise<void> {
  if (initialized) return
  if (!app.isPackaged) {
    log.debug('skipping auto-updater (dev build)')
    return
  }
  const autoUpdater = await loadUpdater()
  if (!autoUpdater) return

  initialized = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => log.info('checking for updates'))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('update available', { extra: { version: info.version, releaseDate: info.releaseDate } })
  })
  autoUpdater.on('update-not-available', () => log.debug('no update available'))
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info('update downloaded; will install on quit', { extra: { version: info.version } })
  })
  autoUpdater.on('error', (err: Error) => log.error('auto-updater error', { error: err }))

  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    log.error('initial update check threw', { error: err })
  }
}

/** Menu-driven "Check for Updates..." handler. Shows a dialog for every
 * outcome so the user knows something happened. */
export async function checkForUpdatesInteractive(parent?: BrowserWindow): Promise<void> {
  if (interactiveCheckInFlight) return
  if (!app.isPackaged) {
    dialog.showMessageBox(parent ?? undefined!, {
      type: 'info',
      title: 'Dev build',
      message: 'Updates are disabled in development builds.',
      detail: 'Run the packaged app to test the updater.',
      buttons: ['OK'],
      noLink: true,
    })
    return
  }

  const autoUpdater = await loadUpdater()
  if (!autoUpdater) {
    dialog.showMessageBox(parent ?? undefined!, {
      type: 'error',
      title: 'Updater unavailable',
      message: 'Could not load the auto-updater.',
      detail: 'Check the console for details and try again later.',
      buttons: ['OK'],
      noLink: true,
    })
    return
  }

  interactiveCheckInFlight = true
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result || !result.updateInfo) {
      dialog.showMessageBox(parent ?? undefined!, {
        type: 'info',
        title: 'Up to date',
        message: `You're running the latest version (${app.getVersion()}).`,
        buttons: ['OK'],
        noLink: true,
      })
      return
    }
    const { version } = result.updateInfo
    if (version === app.getVersion()) {
      dialog.showMessageBox(parent ?? undefined!, {
        type: 'info',
        title: 'Up to date',
        message: `You're running the latest version (${app.getVersion()}).`,
        buttons: ['OK'],
        noLink: true,
      })
      return
    }
    // Download is in flight (autoDownload = true). Let the user know so they
    // don't re-click the menu item and trigger a second check.
    dialog.showMessageBox(parent ?? undefined!, {
      type: 'info',
      title: 'Update available',
      message: `Dreambyte ${version} is downloading in the background.`,
      detail: 'The update will install automatically the next time you quit.',
      buttons: ['OK'],
      noLink: true,
    })
  } catch (err: any) {
    log.error('interactive update check failed', { error: err })
    dialog.showMessageBox(parent ?? undefined!, {
      type: 'error',
      title: 'Update check failed',
      message: 'Could not check for updates.',
      detail: err?.message ? String(err.message) : 'Check your connection and try again.',
      buttons: ['OK'],
      noLink: true,
    })
  } finally {
    interactiveCheckInFlight = false
  }
}
