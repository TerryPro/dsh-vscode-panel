/**
 * The Jupyter message envelope: HMAC signing, serialization, and decoding.
 *
 * Every kernel message is `<IDS|MSG>`, an HMAC-SHA256 hex digest of the four JSON
 * parts, then header, parent header, metadata, and content, optionally followed by
 * binary buffers. Signing is not decoration — it is what lets the Host notice a
 * frame that did not come from the kernel it launched, so a decode that fails the
 * check is treated as a protocol error rather than parsed anyway.
 */

import crypto from 'node:crypto'
import type { KernelLanguage } from '../../shared/notebook-protocol.ts'

/** The delimiter that separates ZeroMQ routing frames from the signed envelope. */
export const JUPYTER_DELIMITER = '<IDS|MSG>'

/** Protocol version the workbench declares; ipykernel 6-7 all speak 5.x. */
export const JUPYTER_PROTOCOL_VERSION = '5.3'

export interface KernelMessageHeader {
  msg_id: string
  session: string
  username: string
  date: string
  msg_type: string
  version: string
}

export interface KernelMessage {
  header: KernelMessageHeader
  parentHeader: Record<string, unknown>
  metadata: Record<string, unknown>
  content: Record<string, unknown>
  /** Binary buffers after the four JSON parts (ipywidgets, custom comms). */
  buffers: Buffer[]
  /** IOPub topic frames preceding the delimiter, when present. */
  topic: string
}

export interface OutgoingMessage {
  type: string
  content?: Record<string, unknown>
  metadata?: Record<string, unknown>
  parentHeader?: Record<string, unknown>
  buffers?: readonly Buffer[]
}

/** The four JSON parts, in wire order, of one message. */
function signedParts(
  header: KernelMessageHeader,
  parentHeader: Record<string, unknown>,
  metadata: Record<string, unknown>,
  content: Record<string, unknown>,
): Buffer[] {
  return [
    Buffer.from(JSON.stringify(header), 'utf8'),
    Buffer.from(JSON.stringify(parentHeader), 'utf8'),
    Buffer.from(JSON.stringify(metadata), 'utf8'),
    Buffer.from(JSON.stringify(content), 'utf8'),
  ]
}

/** HMAC-SHA256 hex digest over the signed parts, as Jupyter expects it. */
export function signKernelMessage(key: string, parts: readonly Buffer[]): Buffer {
  if (key === '') return Buffer.from('')
  const digest = crypto.createHmac('sha256', Buffer.from(key, 'utf8'))
  for (const part of parts) digest.update(part)
  return Buffer.from(digest.digest('hex'), 'utf8')
}

/**
 * Build the multipart frame set for one outgoing message.
 *
 * The `msg_id` is generated here because the caller must be able to correlate the
 * reply and every IOPub side effect back to the request it issued.
 */
export function encodeKernelMessage(
  key: string,
  session: string,
  message: OutgoingMessage,
): { frames: Buffer[]; msgId: string } {
  const msgId = crypto.randomUUID()
  const header: KernelMessageHeader = {
    msg_id: msgId,
    session,
    username: 'dsh-workbench',
    date: new Date().toISOString(),
    msg_type: message.type,
    version: JUPYTER_PROTOCOL_VERSION,
  }
  const parts = signedParts(header, message.parentHeader ?? {}, message.metadata ?? {}, message.content ?? {})
  return {
    frames: [
      Buffer.from(JUPYTER_DELIMITER, 'utf8'),
      signKernelMessage(key, parts),
      ...parts,
      ...(message.buffers ?? []).map(frame => Buffer.from(frame)),
    ],
    msgId,
  }
}

/**
 * Decode one received multipart message.
 *
 * @param key connection-file key the kernel was launched with.
 * @param frames raw frames from a shell, control, or IOPub socket.
 * @returns the parsed message.
 * @throws when the message has no delimiter, is truncated, fails its signature, or
 * carries JSON the workbench cannot read — each of which the caller treats as a
 * protocol failure for that kernel rather than accepting unauthenticated output.
 */
export function decodeKernelMessage(key: string, frames: readonly Buffer[]): KernelMessage {
  const delimiter = frames.findIndex(frame => frame.toString('utf8') === JUPYTER_DELIMITER)
  if (delimiter < 0) throw new Error('kernel message is missing its delimiter')
  const tail = frames.slice(delimiter + 1)
  if (tail.length < 5) throw new Error('kernel message is truncated')
  const signature = tail[0] ?? Buffer.from('')
  const json = tail.slice(1, 5)
  const expected = signKernelMessage(key, json)
  if (!signaturesMatch(expected, signature)) throw new Error('kernel message signature mismatch')
  return {
    header: parsePart(json[0] ?? Buffer.from('{}')) as KernelMessageHeader,
    parentHeader: parsePart(json[1] ?? Buffer.from('{}')) as Record<string, unknown>,
    metadata: parsePart(json[2] ?? Buffer.from('{}')) as Record<string, unknown>,
    content: parsePart(json[3] ?? Buffer.from('{}')) as Record<string, unknown>,
    buffers: tail.slice(5).map(frame => Buffer.from(frame)),
    topic: delimiter > 0 ? frames.slice(0, delimiter).map(frame => frame.toString('utf8')).join(',') : '',
  }
}

function signaturesMatch(expected: Buffer, actual: Buffer): boolean {
  if (expected.length === 0 && actual.length === 0) return true
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(expected, actual)
}

function parsePart(part: Buffer): unknown {
  try {
    return JSON.parse(part.toString('utf8')) as unknown
  } catch {
    throw new Error('kernel message carried invalid JSON')
  }
}

/** Reply content for a request, keeping the `status` shape the spec requires. */
export function kernelErrorContent(content: Record<string, unknown>): Record<string, unknown> {
  return { status: 'error', ...content }
}

/** Pull the language facts out of a `kernel_info_reply` payload. */
export function kernelLanguageFromInfo(content: Record<string, unknown>): KernelLanguage {
  const info = content['language_info']
  const record = typeof info === 'object' && info !== null && !Array.isArray(info)
    ? info as Record<string, unknown>
    : {}
  const mode = record['codemirror_mode']
  const modeName = typeof mode === 'string'
    ? mode
    : typeof mode === 'object' && mode !== null && typeof (mode as Record<string, unknown>)['name'] === 'string'
      ? (mode as Record<string, string>)['name'] ?? ''
      : ''
  return {
    name: typeof record['name'] === 'string' ? record['name'] : 'python',
    version: typeof record['version'] === 'string' ? record['version'] : '',
    ...(typeof record['file_extension'] === 'string' ? { fileExtension: record['file_extension'] } : {}),
    ...(modeName !== '' ? { codemirrorMode: modeName } : {}),
  }
}

/** `true` when a reply header identifies the message this client sent. */
export function isReplyTo(message: KernelMessage, msgId: string, suffix: string): boolean {
  return message.header.msg_type === suffix && message.parentHeader['msg_id'] === msgId
}
