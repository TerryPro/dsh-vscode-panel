/**
 * ZMTP 3.0 client sockets over TCP, with the NULL security mechanism.
 *
 * A Jupyter kernel exposes its channels as ZeroMQ sockets, so talking to one needs
 * a ZeroMQ peer. Linking `libzmq` (through `zmq` or `zeromq`) would mean a native
 * module the plugin host has to build and approve, which is the dependency this
 * workbench already refuses for terminals — and the protocol a kernel actually
 * speaks on loopback is the narrow, stable subset implemented here: a fixed
 * greeting, the NULL handshake, message frames, and the SUB subscription command.
 *
 * Framing follows 23/ZMTP: flags (bit 0 MORE, bit 1 LONG, bit 2 COMMAND), then a
 * one-octet size, or an eight-octet big-endian size when LONG is set.
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'

const GREETING_SIZE = 64
const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** ZMTP socket types a kernel frontend needs. */
export type ZmtpSocketType = 'DEALER' | 'SUB'

export interface ZmtpSocketOptions {
  host: string
  port: number
  socketType: ZmtpSocketType
  /** Subscription filters for a SUB socket; an empty string subscribes to all. */
  subscriptions?: readonly string[]
  /** Refuse a peer announcing a mechanism other than NULL. */
  signalTimeoutMs?: number
}

export interface ZmtpSocketEvents {
  /** One complete multipart message arrived. */
  message(frames: Buffer[]): void
  /** The socket is past the handshake and usable. */
  ready(): void
  /** The peer closed, or the socket failed. */
  close(error: Error | null): void
}

function writeUInt64BE(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32BE(Math.floor(value / 0x1_0000_0000), offset)
  buffer.writeUInt32BE(value % 0x1_0000_0000, offset + 4)
}

function readUInt64BE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset) * 0x1_0000_0000 + buffer.readUInt32BE(offset + 4)
}

/** Frame prefix: flags plus a short or long size field. */
function framePrefix(size: number, flags: number): Buffer {
  if (size > 255) {
    const head = Buffer.alloc(9)
    head[0] = flags | 0x02
    writeUInt64BE(head, 1, size)
    return head
  }
  return Buffer.from([flags, size])
}

function messageFrame(body: Buffer, more: boolean): Buffer {
  return Buffer.concat([framePrefix(body.length, more ? 0x01 : 0x00), body])
}

function commandFrame(body: Buffer): Buffer {
  return Buffer.concat([framePrefix(body.length, 0x04), body])
}

/** A READY property: one length octet, the name, a four-octet size, the value. */
function readyProperty(name: string, value: string): Buffer {
  const nameBuffer = Buffer.from(name, 'latin1')
  const valueBuffer = Buffer.from(value, 'utf8')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(valueBuffer.length)
  return Buffer.concat([Buffer.from([nameBuffer.length]), nameBuffer, size, valueBuffer])
}

function readyFrame(socketType: ZmtpSocketType): Buffer {
  return commandFrame(Buffer.concat([
    Buffer.from([5]),
    Buffer.from('READY', 'latin1'),
    readyProperty('Socket-Type', socketType),
    readyProperty('Identity', ''),
  ]))
}

/** ZMTP subscription: a message frame carrying a leading 0x01 then the filter. */
function subscribeFrame(filter: string): Buffer {
  return messageFrame(Buffer.concat([Buffer.from([0x01]), Buffer.from(filter, 'utf8')]), false)
}

/** ZMTP 3.0 greeting announcing version 3.0 and the NULL mechanism. */
function greeting(): Buffer {
  const buffer = Buffer.alloc(GREETING_SIZE)
  buffer[0] = 0xff
  buffer[9] = 0x7f
  buffer[10] = 3
  buffer[11] = 0
  Buffer.from('NULL').copy(buffer, 12)
  return buffer
}

type Phase = 'awaiting-greeting' | 'awaiting-ready' | 'ready' | 'closed'

/**
 * One ZMTP client connection.
 *
 * The class owns its socket from connect to destroy, reassembles multipart
 * messages, and reports failure through the `close` event rather than a thrown
 * error, so a kernel that dies mid-run cannot take the DSH host down with it.
 */
export class ZmtpSocket extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0)
  private phase: Phase = 'awaiting-greeting'
  private pending: Buffer[] = []
  private outbox: Buffer[] = []
  private socket: net.Socket
  private failure: Error | null = null
  private timer: NodeJS.Timeout | undefined
  private destroyed = false

  constructor(private readonly options: ZmtpSocketOptions) {
    super()
    this.socket = net.connect({ host: options.host, port: options.port, noDelay: true })
    // libzmq sends its partial greeting and then waits for the peer's, so ours
    // must go out on connect rather than after a full read.
    this.socket.once('connect', () => { this.socket.write(greeting()) })
    this.socket.on('data', chunk => { this.consume(chunk) })
    this.socket.on('error', error => { this.fail(error) })
    this.socket.on('close', () => { this.finish() })
    const timeoutMs = options.signalTimeoutMs ?? 30_000
    this.timer = setTimeout(() => { this.fail(new Error('ZMTP handshake timed out')) }, timeoutMs)
    this.timer.unref?.()
  }

  /** Whether the handshake completed and frames can flow. */
  get usable(): boolean {
    return this.phase === 'ready'
  }

  onMessage(handler: ZmtpSocketEvents['message']): this {
    this.on('message', handler)
    return this
  }

  onClose(handler: ZmtpSocketEvents['close']): this {
    this.on('close', handler)
    return this
  }

  /** Queue or send one multipart message; frames sent before ready are not lost. */
  send(frames: readonly Buffer[]): void {
    if (this.destroyed) return
    const payload = Buffer.concat(frames.map((frame, index) => messageFrame(frame, index < frames.length - 1)))
    if (this.phase === 'ready') this.socket.write(payload)
    else this.outbox.push(payload)
  }

  /** End the connection without surfacing a failure to listeners. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.phase = 'closed'
    this.clearTimer()
    this.socket.destroy()
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.phase === 'awaiting-greeting') {
        if (this.buffer.length < 11) return
        if (this.buffer[0] !== 0xff || this.buffer[9] !== 0x7f) {
          this.fail(new Error('peer is not speaking ZMTP 3.x'))
          return
        }
        if ((this.buffer[10] ?? 0) < 3) {
          this.fail(new Error(`ZMTP ${this.buffer[10]}.${this.buffer[11] ?? 0} is not supported`))
          return
        }
        if (this.buffer.length < GREETING_SIZE) return
        const mechanism = this.buffer.subarray(12, 32).toString('latin1').replace(/\0+$/u, '')
        this.buffer = this.buffer.subarray(GREETING_SIZE)
        if (mechanism !== 'NULL') {
          this.fail(new Error(`ZMTP mechanism ${mechanism} is not supported`))
          return
        }
        this.phase = 'awaiting-ready'
        this.socket.write(readyFrame(this.options.socketType))
        continue
      }
      if (this.buffer.length < 2) return
      const flags = this.buffer[0] ?? 0
      const long = (flags & 0x02) !== 0
      const headerSize = long ? 9 : 2
      if (this.buffer.length < headerSize) return
      const size = long ? readUInt64BE(this.buffer, 1) : (this.buffer[1] ?? 0)
      if (size > MAX_FRAME_BYTES) {
        this.fail(new Error('ZMTP frame exceeds the workbench limit'))
        return
      }
      if (this.buffer.length < headerSize + size) return
      const body = this.buffer.subarray(headerSize, headerSize + size)
      this.buffer = this.buffer.subarray(headerSize + size)
      if ((flags & 0x04) !== 0) {
        // Command frames are handshake-only here; the SUB filter echo of an XPUB
        // and anything unknown is simply not part of the notebook protocol.
        if (this.phase === 'awaiting-ready') this.finishHandshake(body)
        continue
      }
      this.pending.push(Buffer.from(body))
      if ((flags & 0x01) === 0) {
        const frames = this.pending
        this.pending = []
        this.emit('message', frames)
      }
    }
  }

  private finishHandshake(body: Buffer): void {
    const nameLength = body[0] ?? 0
    const name = body.subarray(1, 1 + nameLength).toString('latin1')
    if (name === 'ERROR') {
      this.fail(new Error(`ZMTP rejected: ${body.subarray(1 + nameLength).toString('latin1') || 'unknown reason'}`))
      return
    }
    if (name !== 'READY') {
      this.fail(new Error(`unexpected ZMTP handshake command ${name}`))
      return
    }
    this.phase = 'ready'
    this.clearTimer()
    for (const filter of this.options.subscriptions ?? []) this.socket.write(subscribeFrame(filter))
    for (const payload of this.outbox) this.socket.write(payload)
    this.outbox = []
    this.emit('ready')
  }

  private fail(error: Error): void {
    if (this.failure === null) this.failure = error
    // A failed handshake or an oversized frame is not recoverable; end the
    // connection so the kernel side releases it and `close` reaches listeners.
    if (!this.destroyed) this.socket.destroy()
  }

  private finish(): void {
    if (this.destroyed) {
      this.phase = 'closed'
      return
    }
    this.phase = 'closed'
    this.clearTimer()
    this.emit('close', this.failure)
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

/**
 * Wait until a TCP port accepts a connection.
 *
 * A kernel binds its own sockets after the process starts, and the only reliable
 * signal that it is ready to talk is that the port answers. Polling a connect
 * attempt costs nothing and avoids racing the kernel's own startup log.
 * @param timeoutMs how long to keep trying before rejecting.
 */
export function waitForPort(host: string, port: number, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    let settled = false
    let probe: net.Socket | undefined
    const attempt = (): void => {
      if (settled) return
      if (Date.now() > deadline) {
        settled = true
        cleanup()
        reject(new Error('kernel did not open its ports in time'))
        return
      }
      probe = net.connect({ host, port })
      probe.once('connect', () => {
        probe?.destroy()
        if (settled) return
        settled = true
        cleanup()
        resolve()
      })
      probe.once('error', () => {
        probe?.destroy()
        setTimeout(attempt, 100)
      })
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      probe?.destroy()
      cleanup()
      reject(new Error('kernel startup was cancelled'))
    }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    attempt()
  })
}
