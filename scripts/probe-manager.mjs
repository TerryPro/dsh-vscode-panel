/**
 * The kernel manager panel, over real HTTP.
 *
 * `list` is the only kernel read that is not token-scoped and `reclaim` the only write
 * that is not token-checked, so what matters here is security: what a page can learn
 * without a token, and what it can stop. These are asserted against the **wire
 * format**, not the class — a route that serialized the whole managed object would pass
 * a unit test on the manager and still ship the secret.
 *
 * The scenario drives one kernel it owns and finds it by id among whatever else is
 * running, because that is the situation the panel actually faces: a list of several
 * kernels, only some of them reachable.
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Find this client's own row in a list response. */
function rowFor(value, kernelId) {
  return (value?.kernels ?? []).find(entry => entry.kernelId === kernelId)
}

export async function scenarioManager(client, check, { reclaimGraceMs = 5_000 } = {}) {
  const listed = await client.post('/list', { workspaceId: 'ws-1' })
  check('the kernel list answers without a token', listed.status === 200, String(listed.status))
  const row = rowFor(listed.value, client.handle.kernelId)
  check('this kernel appears in the list', row !== undefined)
  if (row === undefined) return
  check('the row names its notebook and kernel',
    row.path === client.notebookPath && typeof row.specName === 'string',
    `${row.path}/${row.specName}`)
  check('the row reports the real process id', typeof row.pid === 'number' && row.pid > 0, String(row.pid))

  // The security property, read off the wire: nothing in this response may unlock a
  // kernel. A token here would turn a read-only panel into a key for every notebook.
  const serialized = JSON.stringify(listed.value)
  check('the list carries no kernel token', !serialized.includes(client.handle.token), 'token leaked')
  check('the list carries no connection key, port, or file',
    !/"(token|key|ports|shellPort|controlPort|iopubPort|stdinPort|hbPort|connectionFile|directory)"/u
      .test(serialized))
  check('the list leaks no host absolute path',
    !/(?:[A-Za-z]:\\|\/home\/|\/Users\/|\/tmp\/)/u.test(serialized))

  check('the ceilings travel with the list',
    typeof listed.value?.maxKernelsPerWorkspace === 'number'
    && typeof listed.value?.maxKernelsTotal === 'number'
    && typeof listed.value?.totalKernels === 'number',
    `${listed.value?.totalKernels}/${listed.value?.maxKernelsTotal}`)

  // A page attached to the stream is "watched", and that is what gates reclaim.
  check('an attached kernel is reported as watched', row.attached === 1, String(row.attached))
  check('a watched kernel is not offered as reclaimable',
    row.orphan === false && row.reclaimable === false,
    `orphan=${row.orphan} reclaimable=${row.reclaimable}`)

  const refused = await client.post('/reclaim', { workspaceId: 'ws-1', kernelId: client.handle.kernelId })
  check('reclaim refuses a kernel a page is watching', refused.status === 409,
    `${refused.status} ${refused.value?.error?.code}`)
  const survived = rowFor((await client.post('/list', { workspaceId: 'ws-1' })).value, client.handle.kernelId)
  check('the refused reclaim left the kernel running', survived !== undefined)

  // Cross-site and cross-workspace must fail exactly as on every other arm.
  const crossSite = await fetch(`${client.base}/dsh-workbench-layout/kernel/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ workspaceId: 'ws-1' }),
  })
  check('a cross-site list is rejected', crossSite.status === 403, String(crossSite.status))
  const otherSpace = await client.post('/list', { workspaceId: 'ws-999' })
  check('another workspace sees nothing here',
    otherSpace.status === 200 && (otherSpace.value?.kernels ?? []).length === 0,
    `${otherSpace.value?.kernels?.length} rows`)
  const noWorkspace = await client.post('/list', {})
  check('a list with no workspace is refused', noWorkspace.status === 400,
    String(noWorkspace.value?.error?.code))

  /*
   * Now detach, and the kernel becomes the thing this panel exists for: reachable
   * from nowhere else. The grace period must still hold, because a reloading page is
   * indistinguishable from a closed tab for a moment, and reclaiming then would throw
   * away a run the reader can still see.
   */
  client.stream.close()
  await sleep(700)
  const detached = rowFor((await client.post('/list', { workspaceId: 'ws-1' })).value, client.handle.kernelId)
  check('closing the stream makes the kernel an orphan',
    detached?.attached === 0 && detached?.orphan === true,
    `attached=${detached?.attached} orphan=${detached?.orphan}`)
  check('an orphan is still not reclaimable inside the grace period',
    detached?.reclaimable === false, String(detached?.reclaimable))
  const early = await client.post('/reclaim', { workspaceId: 'ws-1', kernelId: client.handle.kernelId })
  check('reclaim refuses inside the grace period', early.status === 409,
    `${early.status} ${early.value?.error?.code}`)

  await sleep(reclaimGraceMs + 400)
  const marked = rowFor((await client.post('/list', { workspaceId: 'ws-1' })).value, client.handle.kernelId)
  check('the kernel becomes reclaimable once the grace period passes',
    marked?.reclaimable === true, String(marked?.reclaimable))
  // Reclaiming with no token at all is the point: a kernel left behind by a closed tab
  // is otherwise unreachable until the unattended timer fires minutes later.
  const reclaimed = await client.post('/reclaim', { workspaceId: 'ws-1', kernelId: client.handle.kernelId })
  check('an unattended kernel is reclaimed without a token',
    reclaimed.status === 200 && reclaimed.value?.phase === 'terminated',
    `${reclaimed.status} ${reclaimed.value?.phase ?? reclaimed.value?.error?.code}`)
  check('the reclaimed kernel leaves the list',
    rowFor((await client.post('/list', { workspaceId: 'ws-1' })).value, client.handle.kernelId) === undefined)
  const twice = await client.post('/reclaim', { workspaceId: 'ws-1', kernelId: client.handle.kernelId })
  check('reclaiming twice reports it as gone', twice.status === 404, String(twice.status))
}
