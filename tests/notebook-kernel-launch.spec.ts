/**
 * The exact command line the Host hands to the kernel bridge.
 *
 * This shape is not decoration. Two separate bugs lived here: a kernel command that
 * lost its `-f`, which made a started kernel unreachable, and a working directory
 * derived from the connection file instead of the notebook, which made every relative
 * path in a cell resolve against a private temporary directory. Both produce a kernel
 * that "works" until a cell fails for a reason the reader cannot see.
 */
import { describe, expect, it } from 'vitest'
import { bridgeInvocation, kernelCommandForPlan } from '../src/host/kernel/kernel-session.ts'
import type { KernelLaunchPlan } from '../src/host/kernel/kernel-session.ts'

const CONNECTION = '/tmp/dsh-kernel-abc/connection.json'

const plan = (over: Partial<KernelLaunchPlan> = {}): KernelLaunchPlan => ({
  bridgeScript: '/app/lib/kernel-bridge.py',
  bridgeInterpreter: '/py/bin/python',
  displayName: 'Python 3',
  specName: 'python3',
  interpreterPath: '/py/bin/python',
  workingDirectory: '/work/notebooks',
  notebookPath: 'nb.ipynb',
  kernelArgv: ['/py/bin/python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
  ...over,
})

describe('the bridge invocation', () => {
  it('passes the notebook directory where the kernel starts', () => {
    const command = bridgeInvocation(plan(), CONNECTION)
    expect(command.file).toBe('/py/bin/python')
    // <interpreter> -I -B <bridge> <connection-file> <working-dir> <kernel command...>
    expect(command.args).toEqual([
      '-I',
      '-B',
      '/app/lib/kernel-bridge.py',
      CONNECTION,
      '/work/notebooks',
      '/py/bin/python',
      '-m',
      'ipykernel_launcher',
      '-f',
      CONNECTION,
    ])
  })

  it('takes the working directory from the plan, not from the connection file', () => {
    // The regression this guards: the connection file is in a temporary directory of
    // the Host's own, and using its parent put the kernel somewhere the notebook's
    // data files were not.
    const command = bridgeInvocation(plan({ workingDirectory: 'C:\\work\\deep\\nooks' }), CONNECTION)
    expect(command.args[4]).toBe('C:\\work\\deep\\nooks')
    expect(command.args).not.toContain('/tmp/dsh-kernel-abc')
  })

  it('gives the working directory its own slot, after the connection file', () => {
    const command = bridgeInvocation(plan(), CONNECTION)
    expect(command.args[3]).toBe(CONNECTION)
    expect(command.args[4]).toBe(plan().workingDirectory)
    expect(command.args[4]).not.toBe(command.args[3])
  })

  it('keeps the working directory out of the kernel command', () => {
    // Only the bridge sees the directory; the kernel argv carries the connection file,
    // so a spec can never disagree with the Host about which file to read.
    expect(kernelCommandForPlan(plan(), CONNECTION)).not.toContain('/work/notebooks')
  })

  it('still guarantees -f for a spec that forgot it', () => {
    const command = bridgeInvocation(plan({ kernelArgv: ['/py/bin/python', '-m', 'ipykernel_launcher'] }), CONNECTION)
    const tail = command.args.slice(5)
    expect(tail).toEqual(['/py/bin/python', '-m', 'ipykernel_launcher', '-f', CONNECTION])
  })

  it('runs a spec with its own flags behind the same working directory', () => {
    const command = bridgeInvocation(plan({
      kernelArgv: ['python', '--logfile', '{connection_file}.log', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
    }), CONNECTION)
    expect(command.args[4]).toBe('/work/notebooks')
    expect(command.args.slice(5)).toEqual([
      '/py/bin/python', '--logfile', `${CONNECTION}.log`, '-m', 'ipykernel_launcher', '-f', CONNECTION,
    ])
  })
})
