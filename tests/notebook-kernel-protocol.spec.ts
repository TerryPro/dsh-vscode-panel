import { describe, expect, it } from 'vitest'
import {
  encodeKernelMessage,
  decodeKernelMessage,
  kernelLanguageFromInfo,
  signKernelMessage,
  JUPYTER_DELIMITER,
} from '../src/host/kernel/messaging.ts'
import { kernelCommandForPlan, parseBridgeLine, truncateOutput, type KernelLaunchPlan } from '../src/host/kernel/kernel-session.ts'
import { isPythonIpykernelSpec, kernelArgvForInterpreter, specInterpreterOf } from '../src/host/kernel/discovery.ts'

const KEY = 'a-key-from-the-connection-file'
const SESSION = 'session-1'

function decode(frames: Buffer[], key = KEY) {
  return decodeKernelMessage(key, frames)
}

describe('jupyter message envelope', () => {
  it('round-trips a message through sign and decode', () => {
    const { frames, msgId } = encodeKernelMessage(KEY, SESSION, {
      type: 'execute_request',
      content: { code: 'print(1)' },
      metadata: { depth: 0 },
    })
    const message = decode(frames)
    expect(message.header.msg_type).toBe('execute_request')
    expect(message.header.msg_id).toBe(msgId)
    expect(message.header.session).toBe(SESSION)
    expect(message.header.version).toBe('5.3')
    expect(message.content).toEqual({ code: 'print(1)' })
    expect(message.metadata).toEqual({ depth: 0 })
    expect(message.parentHeader).toEqual({})
  })

  it('places the delimiter first for shell and control channels', () => {
    const { frames } = encodeKernelMessage(KEY, SESSION, { type: 'kernel_info_request' })
    expect(frames[0]?.toString('utf8')).toBe(JUPYTER_DELIMITER)
  })

  it('rejects a frame whose signature does not match', () => {
    const { frames } = encodeKernelMessage(KEY, SESSION, { type: 'execute_request', content: { code: 'ok' } })
    // One byte of the content changed after signing: the signature no longer matches,
    // and accepting such a frame would let any local process inject notebook output.
    const tampered = [...frames]
    const content = tampered[5]!
    tampered[5] = Buffer.from(JSON.stringify({ code: 'evil' }), 'utf8')
    expect(content.length).toBeGreaterThan(0)
    expect(() => decode(tampered)).toThrow(/signature/u)
  })

  it('rejects a frame signed with a different key', () => {
    const { frames } = encodeKernelMessage('other-key', SESSION, { type: 'execute_request' })
    expect(() => decode(frames)).toThrow(/signature/u)
  })

  it('accepts an unsigned message only when the key is empty', () => {
    // `key: ""` is the spec's explicit way to disable signing; it must not be reachable
    // by accident, which is why a non-empty expected key still refuses an empty one.
    const { frames } = encodeKernelMessage('', SESSION, { type: 'execute_request', content: { a: 1 } })
    expect(frames[1]?.length).toBe(0)
    expect(decode(frames, '')).toMatchObject({ content: { a: 1 } })
    expect(() => decode(frames, KEY)).toThrow(/signature/u)
  })

  it('rejects a frame with no delimiter or too few parts', () => {
    expect(() => decode([Buffer.from('x'), Buffer.from('y'), Buffer.from('{}'), Buffer.from('{}'), Buffer.from('{}'), Buffer.from('{}'), Buffer.from('{}')]))
      .toThrow(/delimiter/u)
    const { frames } = encodeKernelMessage(KEY, SESSION, { type: 'execute_request' })
    expect(() => decode(frames.slice(0, 4))).toThrow(/truncated/u)
  })

  it('rejects a frame whose JSON part is not JSON', () => {
    const { frames } = encodeKernelMessage(KEY, SESSION, { type: 'execute_request' })
    const broken = [...frames]
    // `frames` is [delimiter, signature, header, parent, metadata, content]; the four
    // signed parts are indices 2..5. Re-signing is what a forger without the key
    // cannot do, so this proves the parser itself refuses an unreadable body rather
    // than returning a message with `undefined` fields.
    broken[2] = Buffer.from('{ not json', 'utf8')
    broken[1] = signKernelMessage(KEY, broken.slice(2, 6))
    expect(() => decode(broken)).toThrow(/invalid JSON/u)
  })

  it('carries binary buffers after the four JSON parts', () => {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const { frames } = encodeKernelMessage(KEY, SESSION, { type: 'display_data', buffers: [payload] })
    const message = decode(frames)
    expect(message.buffers).toHaveLength(1)
    expect(message.buffers[0]?.equals(payload)).toBe(true)
  })

  it('reads the routing topic that a PUB socket prepends on iopub', () => {
    const { frames } = encodeKernelMessage(KEY, SESSION, { type: 'stream', content: { text: 'x' } })
    const withTopic = [Buffer.from('stream.stdout'), ...frames]
    expect(decode(withTopic).topic).toBe('stream.stdout')
  })

  it('echoes a parent header so a reply can be correlated', () => {
    const { frames } = encodeKernelMessage(KEY, SESSION, {
      type: 'input_reply',
      content: { value: 'x' },
      parentHeader: { msg_id: 'parent-1', msg_type: 'input_request' },
    })
    expect(decode(frames).parentHeader).toMatchObject({ msg_id: 'parent-1' })
  })

  it('generates a distinct msg_id per message', () => {
    const first = encodeKernelMessage(KEY, SESSION, { type: 'execute_request' })
    const second = encodeKernelMessage(KEY, SESSION, { type: 'execute_request' })
    expect(first.msgId).not.toBe(second.msgId)
  })

  it('reads language facts out of a real kernel_info_reply payload', () => {
    const language = kernelLanguageFromInfo({
      language_info: { name: 'python', version: '3.12.14', file_extension: '.py', codemirror_mode: { name: 'ipython', version: 3 } },
    })
    expect(language).toEqual({ name: 'python', version: '3.12.14', fileExtension: '.py', codemirrorMode: 'ipython' })
    // A spec that omits everything still yields a usable label rather than undefined.
    expect(kernelLanguageFromInfo({})).toEqual({ name: 'python', version: '' })
    expect(kernelLanguageFromInfo({ language_info: { name: 'r', codemirror_mode: 'r' } }).codemirrorMode).toBe('r')
  })
})

describe('kernel launch command construction', () => {
  const plan = (kernelArgv: readonly string[], interpreterPath = 'C:\\env\\Scripts\\python.exe'): KernelLaunchPlan => ({
    bridgeInterpreter: interpreterPath,
    bridgeScript: 'C:\\app\\kernel-bridge.py',
    kernelArgv,
    interpreterPath,
    displayName: 'Python 3',
    specName: 'python3',
    workingDirectory: 'C:\\work',
    notebookPath: 'nb.ipynb',
  })
  const file = 'C:\\tmp\\kernel.json'

  it('builds the canonical launcher command from a discovered interpreter', () => {
    expect(kernelCommandForPlan(plan([plan([]).interpreterPath, '-m', 'ipykernel_launcher', '-f', '{connection_file}']), file))
      .toEqual(['C:\\env\\Scripts\\python.exe', '-m', 'ipykernel_launcher', '-f', file])
  })

  it('keeps a spec\'s own flags and re-points the connection file', () => {
    // This is the real `python3` spec ipykernel installs, including its
    // `-Xfrozen_modules=off` flag, which must survive.
    const spec = ['C:\\other\\python.exe', '-Xfrozen_modules=off', '-m', 'ipykernel_launcher', '-f', '{connection_file}']
    expect(kernelCommandForPlan(plan(spec), file)).toEqual([
      'C:\\env\\Scripts\\python.exe', '-Xfrozen_modules=off', '-m', 'ipykernel_launcher', '-f', file,
    ])
  })

  it('never drops the -f flag, which is the bug that makes a kernel unreachable', () => {
    // Dropping argv[0] blindly would leave `[interpreter, '-f']` with no file, so the
    // kernel binds a random port the Host can never find.
    const argv = ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}']
    const command = kernelCommandForPlan(plan(argv), file)
    expect(command).toContain(file)
    expect(command[command.indexOf('-f') + 1]).toBe(file)
  })

  it('appends the connection file when a spec omitted it', () => {
    const command = kernelCommandForPlan(plan(['C:\\x\\python.exe', '-m', 'ipykernel_launcher']), file)
    expect(command.slice(-2)).toEqual(['-f', file])
    expect(command[0]).toBe('C:\\env\\Scripts\\python.exe')
  })

  it('adds the launcher module when a spec named only an interpreter', () => {
    const command = kernelCommandForPlan(plan(['C:\\x\\python.exe']), file)
    expect(command).toEqual(['C:\\env\\Scripts\\python.exe', '-m', 'ipykernel_launcher', '-f', file])
  })

  it('falls back to the canonical command for a spec it cannot honour', () => {
    // A wrapper-script spec (`/usr/bin/env kernel.sh`) carries no launcher module the
    // Host could re-point, and appending `-m ipykernel_launcher` to it would hand the
    // kernel a stray positional argument. The canonical command is the coherent answer.
    const command = kernelCommandForPlan(plan(['/usr/bin/env']), file)
    expect(command).toEqual(['C:\\env\\Scripts\\python.exe', '-m', 'ipykernel_launcher', '-f', file])
  })

  it('substitutes the spec placeholders the real ones use', () => {
    // `{sys.executable}` is what a `conda`-installed spec writes, and `{resource_dir}`
    // is how ipykernel's own spec points at its logo directory.
    const spec = {
      name: 'python3',
      displayName: 'p',
      language: 'python',
      argv: ['{sys.executable}', '-Xfrozen_modules=off', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      directory: '/spec',
      debugger: false,
    }
    expect(kernelArgvForInterpreter(spec, '/tmp/k.json', '/env/bin/python', '/spec'))
      .toEqual(['/env/bin/python', '-Xfrozen_modules=off', '-m', 'ipykernel_launcher', '-f', '/tmp/k.json'])
    const absolute = { ...spec, argv: ['C:\\other\\python.exe', '-m', 'ipykernel_launcher', '-f', '{connection_file}'] }
    expect(kernelArgvForInterpreter(absolute, '/tmp/k.json', '/env/bin/python', '/spec')[0]).toBe('/env/bin/python')
    // A head that is neither would be a wrapper program; rewriting it would change
    // what gets executed, so it is left alone.
    const wrapper = { ...spec, argv: ['/usr/bin/env', 'kernel.sh', '-f', '{connection_file}'] }
    expect(kernelArgvForInterpreter(wrapper, '/tmp/k.json', '/env/bin/python', '/spec')[1]).toBe('kernel.sh')
  })
})

describe('kernel bridge protocol lines', () => {
  it('reads the events the bridge emits', () => {
    expect(parseBridgeLine('{"event":"ready","pid":123}')).toEqual({ kind: 'ready' })
    expect(parseBridgeLine('{"event":"kernel-stderr","text":"boom"}')).toEqual({ kind: 'kernel-stderr', text: 'boom' })
    expect(parseBridgeLine('{"event":"interrupted","signalled":true}')).toEqual({ kind: 'interrupted' })
  })

  it('ignores non-protocol noise instead of throwing', () => {
    // The bridge forwards the kernel's own stdout, which is arbitrary text.
    expect(parseBridgeLine('plain log line')).toBeNull()
    expect(parseBridgeLine('{ broken json')).toBeNull()
    expect(parseBridgeLine('[1,2,3]')).toBeNull()
    expect(parseBridgeLine('"a string"')).toBeNull()
    expect(parseBridgeLine('{"no_event":1}')).toBeNull()
    expect(parseBridgeLine('')).toBeNull()
  })
})

describe('output bounds', () => {
  it('cuts a long stream and says how much went missing', () => {
    const item = truncateOutput({ kind: 'stream', name: 'stdout', text: 'x'.repeat(100) }, 10)
    if (item.kind !== 'stream') throw new Error('expected a stream item')
    expect(item.text.startsWith('xxxxxxxxxx')).toBe(true)
    expect(item.text).toContain('90 characters dropped')
    expect(item.text.length).toBeLessThan(100)
  })

  it('keeps the plain fallback of a huge bundle so an output is never blank', () => {
    const item = truncateOutput({
      kind: 'display_data',
      data: { 'text/plain': 'small', 'text/html': '<div>'.repeat(500) },
      metadata: {},
    }, 64)
    if (item.kind !== 'display_data') throw new Error('expected a display item')
    expect(item.data['text/plain']).toBe('small')
    expect(item.data['text/html']).toBeUndefined()
  })

  it('truncates traceback lines rather than dropping the error', () => {
    const item = truncateOutput({ kind: 'error', ename: 'E', evalue: 'v', traceback: ['y'.repeat(500)] }, 20)
    if (item.kind !== 'error') throw new Error('expected an error item')
    expect(item.ename).toBe('E')
    expect(item.traceback[0]).toHaveLength(22)
    expect(item.traceback[0]).toMatch(/ …$/u)
  })
})

describe('kernelspec inspection', () => {
  it('recognizes a python ipykernel spec and nothing else', () => {
    expect(isPythonIpykernelSpec({ name: 'a', displayName: 'a', language: 'python', argv: ['py', '-m', 'ipykernel_launcher', '-f', '{connection_file}'], directory: '', debugger: false })).toBe(true)
    expect(isPythonIpykernelSpec({ name: 'a', displayName: 'a', language: 'python', argv: ['python', '-m', 'ipykernel'], directory: '', debugger: false })).toBe(true)
    expect(isPythonIpykernelSpec({ name: 'a', displayName: 'a', language: 'r', argv: ['R', '--gui=none'], directory: '', debugger: false })).toBe(false)
    expect(isPythonIpykernelSpec({ name: 'a', displayName: 'a', language: 'python', argv: ['python', 'run.py'], directory: '', debugger: false })).toBe(false)
  })

  it('takes the interpreter a spec names for itself', () => {
    expect(specInterpreterOf({ name: 'a', displayName: 'a', language: 'python', argv: ['C:\\runtime\\python.exe', '-m', 'ipykernel_launcher'], directory: '', debugger: false }))
      .toBe('C:\\runtime\\python.exe')
    // A relative `python` would resolve through the DSH host's PATH, not the environment
    // the spec belongs to, so it is refused rather than trusted.
    expect(specInterpreterOf({ name: 'a', displayName: 'a', language: 'python', argv: ['python', '-m', 'ipykernel_launcher'], directory: '', debugger: false }))
      .toBeUndefined()
  })
})
