/** xterm.js 画布，绑定官方 dsh-api-terminal-controller 的 TerminalView 模型。 */

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalView, TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { WorkbenchController, WorkbenchTerminalTab } from '../model/controller.ts'
import type { TerminalBinding, TerminalStatus } from '../model/controller.ts'
import {
  EDITOR_TRANSITION_END_EVENT,
  EDITOR_TRANSITION_START_EVENT,
  isEditorTrackExpanded,
  isEditorTrackTransitioning,
} from '../layout/editor-layout-contract.ts'
import { terminalName } from './terminal-name.ts'
import { TerminalStatusBar } from './TerminalStatusBar.tsx'
import css from './terminal.module.css'

export interface TerminalSurfaceProps {
  tab: WorkbenchTerminalTab
  active: boolean
  controller: WorkbenchController
  t: TranslateNS<'workbench'>
}

/**
 * Render one workspace terminal on top of DSH's official terminal model.
 *
 * The process, transport, and screen recovery are owned by `TerminalView`
 * (backed by the Gateway Remote stream), so this surface only mounts an xterm
 * emulator and forwards input, resize, and frame acknowledgement.
 */
export function TerminalSurface({ tab, active, controller, t }: TerminalSurfaceProps) {
  const binding = controller.terminalBinding(tab)
  const view = binding === 'ready' ? controller.terminalView(tab) : undefined
  const state = useTerminalView(view)
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const lastRevisionRef = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active
  const viewRef = useRef(view)
  viewRef.current = view
  const writableRef = useRef(state?.writable === true)
  writableRef.current = state?.writable === true
  // The fit routine lives in the mount effect's closure; this ref lets the
  // active/writable effect re-run it once a freshly-opened terminal becomes ready.
  const fitScreenRef = useRef<() => void>(() => {})

  // Attach the model's process to this DOM occurrence for as long as it is mounted.
  useEffect(() => {
    if (view === undefined) return
    return view.mount()
  }, [view])

  // Keep the emulator's live input wired to whichever model this tab resolves to.
  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal === null || view === undefined) return
    const input = terminal.onData(data => { view.write(data) })
    return () => { input.dispose() }
  }, [view])

  // Own the xterm emulator lifecycle: create it once, keep its grid fitted to
  // the container, and react to DSH design-token theme changes.
  useTerminalFit({ hostRef, terminalRef, lastRevisionRef, viewRef, activeRef, writableRef, fitScreenRef })

  // Re-fit and focus when the tab becomes active or gains/loses input control.
  useLayoutEffect(() => {
    const terminal = terminalRef.current
    if (terminal === null) return
    terminal.options.disableStdin = state?.writable !== true
    if (active && state?.writable === true) {
      terminal.focus()
      // A terminal that mounted while still connecting skipped its first fit
      // (it was not writable yet); re-fit now that it is ready so the emulator
      // adopts the full host height instead of the server's default row count.
      fitScreenRef.current()
    }
  }, [active, state?.writable])

  // Mirror the official view phase onto the tab so the tab and rail dots stay in sync.
  useEffect(() => {
    if (state !== undefined) controller.setTerminalStatus(tab.id, viewStatus(state))
  }, [controller, state, tab.id])

  // A tab opened before any Session was bound claims the Session that actually
  // allocated its process, so a later switch knows which Session owns it.
  const hasProcess = state?.info !== undefined
  useEffect(() => {
    if (hasProcess && tab.ownerSessionId === undefined) controller.recordTerminalOwner(tab.id)
  }, [controller, hasProcess, tab.id, tab.ownerSessionId])

  // Mirror the shell the Host resolved, so a row names the shell its process
  // actually runs — the only label that is right for a restored process too.
  useEffect(() => {
    controller.setTerminalShell(tab.id, state?.info?.shell.name)
  }, [controller, state?.info?.shell.name, tab.id])

  // Mirror the Host's title. A fresh terminal is titled after its shell, so the
  // model only adopts a title that differs from it, which keeps an unnamed tab
  // reading "Terminal 3" instead of "pwsh".
  useEffect(() => {
    controller.setTerminalTitle(tab.id, state?.title, state?.info?.shell.name)
  }, [controller, state?.title, state?.info?.shell.name, tab.id])

  // Mirror the process facts the status line reports. Keyed on the fields rather
  // than the info object, which the Host rebuilds on every output frame.
  useEffect(() => {
    controller.setTerminalRuntime(tab.id, state?.info)
  }, [controller, state?.info?.cwd, state?.info?.cols, state?.info?.rows, state?.info?.exitCode, tab.id])

  // Write the next pending frame once the emulator has parsed the previous one.
  useLayoutEffect(() => {
    const terminal = terminalRef.current
    const render = state?.render
    if (terminal === null || view === undefined || render === undefined) return
    if (render.revision <= lastRevisionRef.current) return
    lastRevisionRef.current = render.revision
    const frame = render.frame
    if (frame.type === 'snapshot') {
      terminal.reset()
      terminal.resize(frame.info.cols, frame.info.rows)
    }
    terminal.write(frame.type === 'snapshot' ? frame.screen : frame.data, () => {
      view.acknowledge(render.revision)
      // A snapshot carries the server's grid, which can be taller than this pane
      // right after a split; reconcile back to the fitted container so the bottom
      // rows are not clipped and xterm's scrollbar reflects the real viewport.
      if (frame.type === 'snapshot') fitScreenRef.current()
    })
  }, [state?.render, view])

  const overlay = terminalOverlay(binding, state, view, tab, controller, t)
  return (
    <div className={css.terminalSurface} data-dsh-workbench-terminal="">
      <div className={css.terminalScreen}>
        <div
          ref={hostRef}
          className={css.terminalViewport}
          aria-label={terminalName(tab, t)}
        />
        {overlay !== undefined && (
          <div className={css.terminalEnded} role="status">
            <span>{overlay.message}</span>
            {overlay.action !== undefined && (
              <Button size="sm" variant="outline" onClick={overlay.action.onClick}>
                {overlay.action.label}
              </Button>
            )}
          </div>
        )}
      </div>
      <TerminalStatusBar tab={tab} binding={binding} t={t} />
    </div>
  )
}

interface TerminalOverlay {
  message: string
  action?: { label: string; onClick: () => void }
}

interface TerminalFitRefs {
  hostRef: RefObject<HTMLDivElement>
  terminalRef: MutableRefObject<Terminal | null>
  lastRevisionRef: MutableRefObject<number>
  viewRef: MutableRefObject<TerminalView | undefined>
  activeRef: MutableRefObject<boolean>
  writableRef: MutableRefObject<boolean>
  fitScreenRef: MutableRefObject<() => void>
}

/**
 * Create the xterm emulator once against the host and keep its grid fitted to
 * the container (FitAddon + ResizeObserver + AppFrame track transitions), and
 * react to live DSH design-token theme changes. The supplied refs are read at
 * call time so the fit routine always sees the current view/active/writable.
 */
function useTerminalFit(refs: TerminalFitRefs): void {
  const { hostRef, terminalRef, lastRevisionRef, viewRef, activeRef, writableRef, fitScreenRef } = refs
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.32,
      linkHandler: null,
      scrollback: 1000,
      theme: terminalTheme(host),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    lastRevisionRef.current = 0

    let editorTransitionActive = isEditorTrackTransitioning(host)
    let fitPending = editorTransitionActive || !isEditorTrackExpanded(host)
    const fitScreen = (): void => {
      const view2 = viewRef.current
      if (view2 === undefined || !activeRef.current || !writableRef.current) return
      if (editorTransitionActive || isEditorTrackTransitioning(host) || !isEditorTrackExpanded(host)) {
        fitPending = true
        return
      }
      fitPending = false
      const dimensions = fit.proposeDimensions()
      const environment = view2.state.getSnapshot().environment
      if (dimensions === undefined || host.clientWidth <= 0 || host.clientHeight <= 0) return
      const cols = Math.min(dimensions.cols, environment?.maxCols ?? dimensions.cols)
      const rows = Math.min(dimensions.rows, environment?.maxRows ?? dimensions.rows)
      if (cols < 2 || rows < 1) return
      // Skip when the emulator already matches the fitted grid, so a reconcile
      // after a snapshot never re-notifies the server for a size it already has.
      if (terminal.cols === cols && terminal.rows === rows) return
      terminal.resize(cols, rows)
      view2.resize(cols, rows)
    }
    fitScreenRef.current = fitScreen
    try { fitScreen() } catch { /* The host may be between AppFrame track transitions. */ }

    const onEditorTransitionStart = (event: Event): void => {
      if (!(event.target instanceof HTMLElement) || !event.target.contains(host)) return
      editorTransitionActive = true
      fitPending = true
    }
    const onEditorTransitionEnd = (event: Event): void => {
      if (!(event.target instanceof HTMLElement) || !event.target.contains(host)) return
      editorTransitionActive = false
      if (fitPending) fitScreen()
    }
    document.addEventListener(EDITOR_TRANSITION_START_EVENT, onEditorTransitionStart)
    document.addEventListener(EDITOR_TRANSITION_END_EVENT, onEditorTransitionEnd)
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => { fitScreen() })
    resizeObserver?.observe(host)
    const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme(host) })
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })

    return () => {
      fitScreenRef.current = () => {}
      document.removeEventListener(EDITOR_TRANSITION_START_EVENT, onEditorTransitionStart)
      document.removeEventListener(EDITOR_TRANSITION_END_EVENT, onEditorTransitionEnd)
      resizeObserver?.disconnect()
      themeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [])
}

/** Reduce the official view phase to the tab/rail dot status vocabulary. */
function viewStatus(state: TerminalViewState): TerminalStatus {
  const { phase, issue, info } = state
  if (issue === 'missingTerminal' || phase === 'failed' || phase === 'disconnected') return 'error'
  if (info?.state === 'exited' || phase === 'closed') return 'exited'
  if (phase === 'connected' && info?.state === 'running') return 'running'
  return 'connecting'
}

/**
 * Map the official view phase onto a status line and a single recovery action.
 *
 * A tab left behind by a Session switch is no longer a special case here: it is
 * resolved through its owning Session, so its real phase arrives over its own
 * stream and the ordinary states below describe it. The one case that still needs
 * an explicit offer is a tab whose Host process has gone: retrying the view cannot
 * help, because the saved binding still names the dead identity, so the model
 * keeps treating the tab as a restore view that may not allocate a replacement.
 */
function terminalOverlay(
  binding: TerminalBinding,
  state: TerminalViewState | undefined,
  view: TerminalView | undefined,
  tab: WorkbenchTerminalTab,
  controller: WorkbenchController,
  t: TranslateNS<'workbench'>,
): TerminalOverlay | undefined {
  if (binding === 'noSession') return { message: t('terminal.noSession') }
  if (view === undefined) return { message: t('terminal.noSession') }
  if (state === undefined) return undefined
  const { phase, issue, info, writable } = state
  // The Host terminal behind this tab's content identity is gone. Retrying the
  // view cannot help: the saved binding still names the dead identity, so the
  // model keeps treating this as a restore view that may not allocate a
  // replacement, and every retry re-reports the same miss. Recovery has to drop
  // that binding and take a new content identity, which is exactly what
  // `reopenTerminalHere` does.
  if (issue === 'missingTerminal') {
    return { message: t('terminal.missingTerminal'), action: { label: t('terminal.reopen'), onClick: () => { controller.reopenTerminalHere(tab.id) } } }
  }
  // The Host reports its own quota in English; the official model already mapped
  // `terminal/limit-reached` onto this issue, so the workbench says it in the
  // user's language. Retrying cannot succeed while the Session is still at its
  // limit, so no action is offered — closing a tab is what frees a slot.
  if (issue === 'terminalLimit') return { message: t('terminal.limitReached') }
  if (phase === 'disconnected') {
    return { message: t('terminal.disconnected'), action: { label: t('terminal.restart'), onClick: () => { view.connect() } } }
  }
  if (phase === 'failed') {
    return { message: state.error ?? t('terminal.failed'), action: { label: t('terminal.retry'), onClick: () => { void view.refresh() } } }
  }
  if (info?.state === 'exited') {
    return { message: t('terminal.exitMessage', { code: String(info.exitCode ?? 0) }) }
  }
  if (phase === 'connected' && writable === false) {
    return { message: t('terminal.readonly'), action: { label: t('terminal.control'), onClick: () => { view.connect() } } }
  }
  return undefined
}

/** Subscribe one component to the official view's observable state. */
function useTerminalView(view: TerminalView | undefined): TerminalViewState | undefined {
  return useSyncExternalStore(
    callback => view?.state.subscribe(callback) ?? (() => {}),
    () => view?.state.getSnapshot(),
    () => view?.state.getSnapshot(),
  )
}

/**
 * xterm theme resolved from the live DSH design tokens at the host element.
 * `token` is `undefined` for the ANSI slots DSH's palette has no equivalent
 * for (magenta and cyan): those keep their fixed literal so the terminal never
 * depends on a variable the host does not define.
 */
function terminalTheme(host: HTMLElement): ITheme {
  const style = getComputedStyle(host)
  const color = (token: string | undefined, fallback: string): string =>
    token === undefined ? fallback : style.getPropertyValue(token).trim() || fallback
  return {
    background: color('--dsw-alias-bg-base', '#ffffff'),
    foreground: color('--dsw-alias-label-primary', '#1f2329'),
    cursor: color('--dsw-alias-state-business-primary', '#4d7cff'),
    cursorAccent: color('--dsw-alias-bg-base', '#ffffff'),
    selectionBackground: color('--dsw-alias-interactive-bg-active', '#dbe7ff'),
    black: color('--dsw-static-neutral-1000', '#1f2329'),
    red: color('--dsw-alias-state-error-primary', '#d92d20'),
    green: color('--dsw-static-green-500', '#16a34a'),
    yellow: color('--dsw-static-amber-500', '#ca8a04'),
    blue: color('--dsw-alias-state-business-primary', '#4d7cff'),
    magenta: color(undefined, '#9333ea'),
    cyan: color(undefined, '#0891b2'),
    white: color('--dsw-static-neutral-100', '#f5f6f7'),
    brightBlack: color('--dsw-alias-label-tertiary', '#8f959e'),
    brightRed: color('--dsw-alias-state-error-secondary', '#f04438'),
    brightGreen: color('--dsw-static-green-400', '#4ade80'),
    brightYellow: color('--dsw-static-amber-400', '#facc15'),
    brightBlue: color('--dsw-alias-brand-primary', '#6b8cff'),
    brightMagenta: color(undefined, '#c084fc'),
    brightCyan: color(undefined, '#22d3ee'),
    brightWhite: color('--dsw-alias-label-primary', '#ffffff'),
  }
}
