// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createRevealLauncher, revealCommandFor } from '../src/host/reveal-path.ts'

/**
 * The command table is asserted directly rather than through a route, because the shapes
 * that matter here are invisible above them: Explorer's `/select,` switch has to arrive
 * glued to the path in one argument, and a directory must *not* get that switch at all.
 * A test that only checked "some command came back" would pass on both mistakes.
 */
describe('revealCommandFor', () => {
  it('selects a file on Windows with the path inside the switch argument', () => {
    expect(revealCommandFor('win32', 'C:\\ws\\README.md', false)).toEqual({
      file: 'explorer.exe',
      args: ['/select,C:\\ws\\README.md'],
    })
  })

  it('opens a Windows directory without /select, which would highlight nothing', () => {
    expect(revealCommandFor('win32', 'C:\\ws\\docs', true)).toEqual({
      file: 'explorer.exe',
      args: ['C:\\ws\\docs'],
    })
  })

  it('reveals a file on macOS with -R and opens a directory plain', () => {
    expect(revealCommandFor('darwin', '/ws/README.md', false)).toEqual({
      file: 'open',
      args: ['-R', '/ws/README.md'],
    })
    expect(revealCommandFor('darwin', '/ws/docs', true)).toEqual({
      file: 'open',
      args: ['/ws/docs'],
    })
  })

  it('opens either kind through xdg-open on Linux', () => {
    expect(revealCommandFor('linux', '/ws/README.md', false)).toEqual({
      file: 'xdg-open',
      args: ['/ws/README.md'],
    })
    expect(revealCommandFor('linux', '/ws/docs', true)).toEqual({
      file: 'xdg-open',
      args: ['/ws/docs'],
    })
  })

  it('offers no command on a platform with no known file manager', () => {
    // The Host turns this into REVEAL_UNSUPPORTED, so the reader gets a message rather
    // than a spawn of a program that cannot exist.
    expect(revealCommandFor('sunos', '/ws/README.md', false)).toBeNull()
  })
})

/**
 * The launcher's options and its real behaviour against a program that exists and one that
 * does not.
 *
 * The reveal route is the only place the workbench hands a path to a GUI program. The
 * options it passes are asserted on an injected fake — that is the surface where
 * `windowsHide` did its damage — while the two settle modes are asserted on the actual
 * `child_process` behaviour, with a command that starts and exits immediately so no
 * file-manager window appears in anyone's session.
 */
describe('createRevealLauncher', () => {
  it('launches without windowsHide, which on Windows hides the file manager itself', () => {
    // Regression: `windowsHide: true` came from CLI-child habit, but on Windows it is
    // STARTF_USESHOWWINDOW with SW_HIDE, and that applies to a GUI program's window too.
    // The spawn succeeded, the route answered 200, the log said "revealed" — and no
    // Explorer window ever appeared. `RevealSpawnOptions` omits the flag so re-adding it
    // is a compile error; this pins the runtime shape as well, on the exact options the
    // real `spawn` would receive.
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []
    const launcher = createRevealLauncher((file, args, options) => {
      calls.push({ file, args, options: { ...options } })
      return { once: () => {}, unref: () => {} }
    })
    void launcher.launch({ file: 'explorer.exe', args: ['/select,C:\\ws\\a.ts'] })
    expect(calls).toEqual([
      { file: 'explorer.exe', args: ['/select,C:\\ws\\a.ts'], options: { detached: true, stdio: 'ignore' } },
    ])
  })

  it('settles once the program has started, whatever it then exits with', async () => {
    // Explorer returns a non-zero code even when it opened the folder, which is why the
    // launcher answers off `spawn` rather than off the exit.
    const launcher = createRevealLauncher()
    await expect(launcher.launch({ file: process.execPath, args: ['-e', ''] })).resolves.toBeUndefined()
  })

  it('rejects a program that cannot be found', async () => {
    const launcher = createRevealLauncher()
    await expect(launcher.launch({ file: 'dsh-workbench-no-such-file-manager', args: ['/ws/a.ts'] })).rejects.toThrow()
  })
})
