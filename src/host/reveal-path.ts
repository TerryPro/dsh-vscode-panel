/**
 * Showing one path in the operating system's own file manager.
 *
 * This is the one place in the workbench that runs a program for a reason unrelated to
 * Git or to a notebook kernel, and the file manager is *outside* the workspace, so no
 * path policy can bound what it does. The guards that remain are the ones every workbench
 * route already passes — the request came from a page on this machine, and the path it
 * names is one the Host resolved itself from a workspace-relative path — plus the shape
 * below: an argument vector, never a shell line.
 */

import { spawn } from 'node:child_process'

/** One invocation: the program to run and the arguments to hand it, never a shell line. */
export interface RevealCommand {
  file: string
  args: string[]
}

/**
 * The command that reveals `absolutePath` on `platform`, or `null` where no known file
 * manager exists.
 *
 * Windows needs two forms rather than one: Explorer only *selects* an item when the path
 * arrives inside the single `/select,` argument, while a directory has to be passed plain —
 * `/select,` on a folder leaves Explorer showing the parent with nothing highlighted. The
 * comma is part of the switch, so it travels inside that argument and never as its own.
 */
export function revealCommandFor(
  platform: NodeJS.Platform,
  absolutePath: string,
  isDirectory: boolean,
): RevealCommand | null {
  if (platform === 'win32') {
    return isDirectory
      ? { file: 'explorer.exe', args: [absolutePath] }
      : { file: 'explorer.exe', args: [`/select,${absolutePath}`] }
  }
  if (platform === 'darwin') {
    return isDirectory
      ? { file: 'open', args: [absolutePath] }
      : { file: 'open', args: ['-R', absolutePath] }
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return { file: 'xdg-open', args: [absolutePath] }
  }
  return null
}

/** What it takes to launch one command, so a test can record it instead of running it. */
export interface RevealLauncher {
  /** Launch and settle once the program has actually started; reject if it never did. */
  launch(command: RevealCommand): Promise<void>
}

/** The one child-process call shape the launcher makes, kept narrow on purpose. */
export interface RevealSpawnOptions {
  detached: true
  stdio: 'ignore'
}

/** A launched program, reduced to the three things the launcher uses. */
export interface RevealChild {
  once(event: 'error', listener: (error: Error) => void): void
  once(event: 'spawn', listener: () => void): void
  unref(): void
}

/** How the launcher starts a program. Injectable so its options can be asserted. */
export type RevealSpawn = (
  file: string,
  args: string[],
  options: RevealSpawnOptions,
) => RevealChild

/**
 * The launcher the Host uses: detached, with stdio ignored, and **no `windowsHide`**.
 *
 * Detached matters beyond process hygiene. Explorer exits with a non-zero code even when
 * it opened the folder correctly, so a launcher that waited for the exit would report
 * failure on success; `spawn`'s own event tells us the only thing we can act on — that the
 * program was found and started. `stdio: 'ignore'` keeps that true for every platform: a
 * file manager that inherits our pipes would hold the call open for as long as its window
 * is up.
 *
 * `windowsHide: true` is the one option that must not come back, and it is absent from
 * `RevealSpawnOptions` so adding it is a compile error rather than a passing test. It is the
 * usual choice for a CLI child because it suppresses that child's *console*, but Windows
 * implements it as `STARTF_USESHOWWINDOW` with `SW_HIDE`, which applies to a GUI program's
 * window too: the spawn succeeded, the route answered 200, the log said the entry was
 * revealed, and no Explorer window ever appeared. That window is the entire feature.
 */
export function createRevealLauncher(spawnCommand: RevealSpawn = spawn): RevealLauncher {
  return {
    launch: (command) => new Promise<void>((resolveRun, rejectRun) => {
      let child: RevealChild
      try {
        child = spawnCommand(command.file, command.args, { detached: true, stdio: 'ignore' })
      } catch (error: unknown) {
        rejectRun(toError(error))
        return
      }
      // `error` fires asynchronously for a missing program, and `spawn` only once the
      // process exists. Either way the promise settles before anything could observe a
      // revealed window, so the caller's answer is never a false success.
      child.once('error', (error: Error) => { rejectRun(error) })
      child.once('spawn', () => {
        child.unref()
        resolveRun()
      })
    }),
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
