/**
 * File upload shim.
 *
 * Returns a `dreambyte://uploads/<filename>` URL the renderer can hand to
 * <audio>/<video>/<img>. The Electron preload always injects
 * `window.dreambyteApi.media`; if it's missing the renderer is running outside
 * the desktop shell, which is unsupported.
 */

export async function uploadBlob(blob: Blob, filename?: string): Promise<string> {
  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.media : undefined
  if (!ipc) {
    throw new Error('uploadBlob requires the desktop runtime (window.dreambyteApi.media is unavailable).')
  }
  const data = await blob.arrayBuffer()
  const { url } = await ipc.upload({
    data,
    mimeType: blob.type || 'application/octet-stream',
    originalName: filename,
  })
  return url
}
