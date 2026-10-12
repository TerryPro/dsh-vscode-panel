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

/**
 * The launcher the Host uses: detached, so the file manager outlives this call, and with
 * its stdio ignored rather than piped.
 *
 * Detached matters beyond process hygiene. Explorer exits with a non-zero code even when
 * it opened the folder correctly, so a launcher that waited for the exit would report
 * failure on success; `spawn`'s own event tells us the only thing we can act on — that the
 * program was found and started. `stdio: 'ignore'` keeps that true for every platform: a
 * file manager that inherits our pipes would hold the call open for as long as its window
 * is up.
 */
export function createRevealLauncher(): RevealLauncher {
  return {
    launch: (command) => new Promise<void>((resolveRun, rejectRun) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command.file, command.args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
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
