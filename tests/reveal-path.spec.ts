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
 * The real launcher, against a program that exists and one that does not.
 *
 * The reveal route is the only place the workbench hands a path to a GUI program, and both
 * of its failure modes are invisible to an injected fake: a promise that never settles
 * leaves the browser's request hanging with no message at all, and a missing program has to
 * surface as a rejection rather than a silent success. Both are asserted on the actual
 * `child_process` behaviour here, with a command that starts and exits immediately so no
 * file-manager window appears in anyone's session.
 */
describe('createRevealLauncher', () => {
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
