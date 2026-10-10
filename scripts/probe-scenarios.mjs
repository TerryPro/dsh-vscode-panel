/**
 * The probe's scenarios, written only against the kernel HTTP routes.
 *
 * Each answers a product question with a real kernel: does state carry between cells,
 * does a failing cell report itself, can a long cell be interrupted and the kernel
 * survive it, does rich output arrive, and do the introspection helpers work.
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function settled(client, cellId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (client.stream.forCell(cellId, 'cell_completed').length > 0) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

async function run(client, code, cellId) {
  const started = await client.post('/execute', { ...client.handle, code, cellId })
  if (typeof started.value?.msgId !== 'string') {
    return { ok: false, status: started.status, value: started.value }
  }
  return { ok: await settled(client, cellId), msgId: started.value.msgId }
}

/** A variable set in one cell must be readable in the next. */
export async function scenarioState(client, check) {
  await run(client, 'x = 41', 'c1')
  // The print is what proves stdout travels as its own frame; a bare expression would
  // only ever produce an execute_result.
  const second = await run(client, 'print("from c2")\nx * 2', 'c2')
  check('a value set in one cell carries to the next', second.ok)
  const outputs = client.stream.forCell('c2', 'cell_output').map(frame => frame.item)
  const result = outputs.find(item => item?.kind === 'execute_result')
  check('the carried value is 82', result?.data?.['text/plain'] === '82', String(result?.data?.['text/plain']))
  const printed = outputs.find(item => item?.kind === 'stream')
  check('stdout arrived as its own stream', printed?.text?.includes('from c2') === true, String(printed?.text))
  check('stdout and the result kept their arrival order',
    outputs[0]?.kind === 'stream' && outputs[1]?.kind === 'execute_result',
    outputs.map(item => item?.kind).join(','))
  const done = client.stream.forCell('c2', 'cell_completed').at(-1)
  check('the prompt number advanced', typeof done?.executionCount === 'number' && done.executionCount > 0,
    String(done?.executionCount))
}

/** A raising cell reports itself; it must not hang or blank. */
export async function scenarioFailure(client, check) {
  await run(client, 'raise RuntimeError("probe failure")', 'c3')
  const done = client.stream.forCell('c3', 'cell_completed').at(-1)
  check('a failing cell completes with status error', done?.status === 'error', String(done?.status))
  const error = client.stream.forCell('c3', 'cell_output').map(frame => frame.item).find(item => item?.kind === 'error')
  check('the failure named its exception', error?.ename === 'RuntimeError', String(error?.ename))
  check('the failure carried a traceback', Array.isArray(error?.traceback) && error.traceback.length > 0,
    String(error?.traceback?.length))
  // ANSI colour must survive to the browser: that is what the output view renders.
  check('the traceback still carries its ANSI colour',
    (error?.traceback?.[0] ?? '').includes(String.fromCharCode(27)))
}

/** The interrupt ipykernel cannot perform on Windows, delivered by the bridge handle. */
export async function scenarioInterrupt(client, check) {
  const long = 'import time\nfor _ in range(120): time.sleep(0.5)'
  const started = await client.post('/execute', { ...client.handle, code: long, cellId: 'c4' })
  check('the long cell was accepted', typeof started.value?.msgId === 'string')
  await sleep(1_500)
  const busy = await client.post('/status', client.handle)
  check('the kernel reports itself busy', busy.value?.phase === 'busy', String(busy.value?.phase))
  const interrupted = await client.post('/interrupt', client.handle)
  check('interrupt was accepted', interrupted.status === 200, String(interrupted.status))
  check('the interrupted cell stopped', await settled(client, 'c4', 30_000))
  const done = client.stream.forCell('c4', 'cell_completed').at(-1)
  check('the stop was reported as interrupted', done?.status === 'interrupted', String(done?.status))
  const after = await run(client, '1 + 1', 'c6')
  check('the kernel still runs after an interrupt', after.ok)
}

/** A display bundle reaches the browser with every form it carries. */
export async function scenarioRich(client, check) {
  const code = [
    'from IPython.display import display, HTML',
    'display(HTML("<table><tr><td>cell</td></tr></table>"))',
    'import sys',
    'print("to stderr", file=sys.stderr)',
    '{"ok": True}',
  ].join('\n')
  await run(client, code, 'c5')
  const items = client.stream.forCell('c5', 'cell_output').map(frame => frame.item)
  const html = items.find(item => item?.kind === 'display_data' && item.data?.['text/html'] !== undefined)
  check('rich html output arrived', typeof html?.data?.['text/html'] === 'string')
  check('the html bundle kept its plain fallback', typeof html?.data?.['text/plain'] === 'string',
    String(html?.data?.['text/plain']))
  check('stderr arrived separately from stdout', items.some(item => item?.kind === 'stream' && item.name === 'stderr'))
  check('the trailing value became an execute_result', items.some(item => item?.kind === 'execute_result'))
  check('the rich cell completed ok', client.stream.forCell('c5', 'cell_completed').at(-1)?.status === 'ok')
}

/** Completion, introspection, and the code-completeness question. */
export async function scenarioIntrospection(client, check) {
  const complete = await client.post('/complete', { ...client.handle, code: 'pr', cursorPos: 2 })
  check('completion answered', Array.isArray(complete.value?.matches) && complete.value.matches.includes('print'),
    JSON.stringify(complete.value?.matches?.slice(0, 3)))
  const inspect = await client.post('/inspect', { ...client.handle, code: 'print', cursorPos: 5 })
  check('introspection answered', inspect.value?.found === true && typeof inspect.value.text === 'string',
    String(inspect.value?.text).slice(0, 40))
  const open = await client.post('/is-complete', { ...client.handle, code: 'for i in range(3):' })
  check('an open block is incomplete', open.value?.status === 'incomplete', String(open.value?.status))
  const whole = await client.post('/is-complete', { ...client.handle, code: 'x = 1' })
  check('a complete statement is complete', whole.value?.status === 'complete', String(whole.value?.status))
  // The cursor is clamped, not trusted: a hostile browser must not upset the kernel.
  const clamped = await client.post('/complete', { ...client.handle, code: 'ab', cursorPos: 99_999 })
  check('an out-of-range cursor was clamped, not refused', clamped.status === 200, String(clamped.status))
}
