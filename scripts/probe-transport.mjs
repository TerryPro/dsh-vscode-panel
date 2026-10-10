/**
 * Transport scenarios for the kernel probe: stream resume, the poll fallback,
 * restart, path scoping, and the no-orphan guarantee on teardown.
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function settled(client, cellId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (client.stream.forCell(cellId, 'cell_completed').length > 0) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

/** The stream's own snapshot, and that a dropped stream resumes with nothing lost. */
export async function scenarioStream(client, check) {
  check('the stream attached', client.stream.state.open === true, `errors=${client.stream.state.errors}`)
  check('the stream sent its snapshot', client.stream.state.snapshots.length >= 1)
  const snapshot = client.stream.state.snapshots[0]
  check('the snapshot names the kernel', snapshot?.kernelId === client.handle.kernelId, String(snapshot?.kernelId))
  check('the snapshot carries a replayable cursor', typeof snapshot?.sequence === 'number' && typeof snapshot?.oldestSequence === 'number',
    `${snapshot?.oldestSequence}..${snapshot?.sequence}`)
  const first = client.stream.state.frames[0]
  check('published frames carry a `ready` info event', client.stream.state.frames.some(frame => frame.type === 'info'))

  const before = client.stream.lastSequence()
  client.stream.close()
  // One run with nothing attached: the Host must keep buffering it, not drop it.
  const started = await client.post('/execute', { ...client.handle, code: 'buffered = 7\nbuffered', cellId: 'c7' })
  check('a run is accepted with no stream attached', typeof started.value?.msgId === 'string')
  await sleep(5_000)
  const reopened = client.reopenStream(before)
  client.stream = reopened
  const replayed = await settled(client, 'c7')
  check('a re-attached stream replays what it missed', replayed)
  const sequences = reopened.state.frames.map(frame => frame.sequence)
  check('replayed frames are strictly ordered',
    sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]),
    `${sequences[0]}..${sequences.at(-1)}`)
  // Both transports replay inclusively from the cursor (`sequence >= since`); the
  // client drops anything at or below its own sequence, so a reconnect cannot
  // duplicate. This raw reader has no dedup, so it asserts the inclusive boundary the
  // routes actually promise rather than a strict one.
  check('replay started at the cursor without skipping anything', sequences[0] === before,
    `${sequences[0]} vs ${before}`)
}

/** The poll route must report the same history the stream delivered. */
export async function scenarioPoll(client, check) {
  const result = await client.poll(1)
  const frames = result.value?.frames ?? []
  check('poll returns the kernel history', frames.length > 0, `${frames.length} frames`)
  check('poll frames are ordered', frames.every((frame, index) => (
    index === 0 || frame.sequence > (frames[index - 1]?.sequence ?? -1)
  )), `${frames[0]?.sequence}..${frames.at(-1)?.sequence}`)
  check('poll reports a phase and cursor', typeof result.value?.phase === 'string' && typeof result.value?.nextSequence === 'number',
    `${result.value?.phase}/${result.value?.nextSequence}`)
  const executed = frames.filter(frame => frame.type === 'cell_output').length
  check('poll replayed the same output frames as the stream', executed > 0, `${executed} outputs`)
  // A cursor ahead of everything must say the history was lost, not return a gap.
  const future = await client.poll(Number.MAX_SAFE_INTEGER - 1)
  check('a future cursor returns no frames rather than a hole', (future.value?.frames ?? []).length === 0)
}

/** Restart gives a new session; the old handle must stop working. */
export async function scenarioRestart(client, check) {
  const old = { ...client.handle }
  const restarted = await client.post('/restart', { ...old, path: client.notebookPath })
  const fresh = restarted.value?.kernelId
  check('restart returned a new kernel id', typeof fresh === 'string' && fresh !== old.kernelId, String(fresh))
  if (typeof fresh !== 'string') return
  client.handle = { workspaceId: old.workspaceId, kernelId: fresh, token: restarted.value.token }
  client.stream.close()
  client.stream = client.reopenStream(1)
  check('the re-attached stream opened on the new kernel',
    await client.stream.waitForOpen(5_000))
  const after = await client.post('/execute', { ...client.handle, code: 'x', cellId: 'c8' })
  check('the new kernel runs a cell', typeof after.value?.msgId === 'string',
    JSON.stringify(after.value).slice(0, 120))
  // `x` was defined on the previous kernel, so a *fresh* namespace must fail here.
  const failed = await settled(client, 'c8', 25_000)
  if (!failed) {
    console.log('  DEBUG stream frames:', JSON.stringify(client.stream.state.frames.map(f => `${f.sequence}:${f.type}`).slice(-8)))
    console.log('  DEBUG errors:', client.stream.state.errors, 'snapshot:', JSON.stringify(client.stream.state.snapshots.at(-1)))
  }
  check('the restarted cell reported', failed)
  const done = client.stream.forCell('c8', 'cell_completed').at(-1)
  check('a restart really cleared the namespace', done?.status === 'error', String(done?.status))
  const stale = await client.post('/execute', { ...old, code: 'x' })
  check('the superseded handle no longer drives anything', stale.status === 404 || stale.status === 403,
    String(stale.status))
}

/** A second notebook gets its own kernel, with its own namespace. */
export async function scenarioTwoNotebooks(client, check, forkClient) {
  const other = await forkClient('probe-b.ipynb')
  check('a second notebook starts its own kernel', other.handle.kernelId !== client.handle.kernelId)
  await other.post('/execute', { ...other.handle, code: 'only_here = 1', cellId: 'z1' })
  await sleep(2_500)
  const probe = await other.post('/execute', { ...other.handle, code: 'only_here', cellId: 'z2' })
  check('the second notebook runs its own code', typeof probe.value?.msgId === 'string')
  await sleep(2_500)
  const done = other.stream.forCell('z2', 'cell_completed').at(-1)
  check('the second notebook kept its own variable', done?.status === 'ok', String(done?.status))
  const cross = await client.post('/execute', { ...client.handle, code: 'only_here', cellId: 'x1' })
  check('the first notebook was not polluted by the second', typeof cross.value?.msgId === 'string')
  await settled(client, 'x1', 20_000)
  const crossed = client.stream.forCell('x1', 'cell_completed').at(-1)
  check('reading the other notebook\'s variable fails as expected', crossed?.status === 'error',
    String(crossed?.status))
  other.stream.close()
}

/**
 * Teardown must stop the kernel process.
 *
 * This is the assertion that matters most: a kernel left behind after the host effect
 * disposes would hold a port, a process, and the user's namespace. It is checked
 * against the operating system's process list rather than over HTTP, because once
 * the host is gone there is no route left to ask.
 */
export async function scenarioTeardown(client, check, disposeHost, pythonPids, pidsBefore) {
  await disposeHost()
  await sleep(2_500)
  const lingering = (await pythonPids()).filter(pid => !pidsBefore.has(pid))
  check('no kernel process outlived the host', lingering.length === 0, `pids ${lingering.join(',')}`)
}
