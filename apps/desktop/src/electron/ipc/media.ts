import type { IpcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { v4 as uuidv4 } from 'uuid'
import { getUploadsDir, uploadsUrlFor } from '@/lib/uploads/paths'
import { IpcValidationError } from './_helpers'

/**
 * Category: media
 *
 * File upload used by the audio panel, layers panel, and SFX client, with a
 * mime/size policy and a Lottie structural check.
 *
 * URL shape returned to the renderer:
 *   dev      → `/uploads/<filename>`    (served by Next at public/uploads/)
 *   packaged → `dreambyte://uploads/<filename>` (protocol handler reads from userData)
 *
 * This mirrors the `scenes` split — renderer just stores whatever URL
 * comes back and hands it to <audio>/<video>/<img>. Both URL shapes
 * resolve through the runtime that produced them.
 *
 * IPC shape: ArrayBuffer + metadata, NOT File/FormData. structured-clone
 * transports ArrayBuffer across the bridge cheaply; FormData does not
 * clone at all. Renderer helpers in `src/lib/upload.ts` do the File →
 * ArrayBuffer conversion before calling in.
 */

const ALLOWED_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'application/json': 'json',
}

const MAX_SIZE = 100 * 1024 * 1024 // 100MB — matches legacy route cap

type UploadArgs = {
  data: ArrayBuffer
  mimeType: string
  originalName?: string
}

type UploadResult = {
  url: string
  filename: string
}

async function upload(args: UploadArgs): Promise<UploadResult> {
  if (!args || typeof args !== 'object') throw new IpcValidationError('upload args required')
  if (!(args.data instanceof ArrayBuffer)) throw new IpcValidationError('data must be an ArrayBuffer')
  if (typeof args.mimeType !== 'string' || args.mimeType.length === 0) {
    throw new IpcValidationError('mimeType required')
  }

  const ext = ALLOWED_TYPES[args.mimeType]
  if (!ext) throw new IpcValidationError(`Unsupported file type: ${args.mimeType}`)

  if (args.data.byteLength > MAX_SIZE) {
    throw new IpcValidationError('File too large (max 100MB)')
  }

  const buffer = Buffer.from(args.data)

  // Validate Lottie JSON before committing a filename.
  if (ext === 'json') {
    try {
      const json = JSON.parse(buffer.toString('utf-8'))
      if (!json.v || !json.w || !json.h || !json.layers) {
        throw new IpcValidationError('File does not appear to be a valid Lottie animation')
      }
    } catch (err) {
      if (err instanceof IpcValidationError) throw err
      throw new IpcValidationError('Invalid JSON file')
    }
  }

  const uploadsDir = getUploadsDir()
  await fs.mkdir(uploadsDir, { recursive: true })

  const filename = `${uuidv4()}.${ext}`
  const destPath = path.resolve(path.join(uploadsDir, filename))
  if (!destPath.startsWith(uploadsDir + path.sep)) {
    throw new IpcValidationError('Invalid upload path (escape)')
  }
  await fs.writeFile(destPath, buffer)

  return { url: uploadsUrlFor(filename), filename }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:media.upload', (_e, args: UploadArgs) => upload(args))
}
