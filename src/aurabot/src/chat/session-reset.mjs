const normalizePath = (value) => String(value || '').replace(/[\\/]+$/, '').toLowerCase()

export async function requireFreshArchiveState(refreshArchived, archivedFresh) {
  if (typeof refreshArchived !== 'function') throw Object.assign(new Error('archive state refresh unavailable'), { code: 'archived-state-unavailable', stage: 'preflight' })
  try { await refreshArchived() }
  catch (cause) { throw Object.assign(new Error('archive state refresh failed'), { code: 'archived-state-unavailable', stage: 'preflight', cause }) }
  const fresh = typeof archivedFresh === 'function' ? archivedFresh() : archivedFresh
  if (fresh !== true) throw Object.assign(new Error('archive state is not fresh'), { code: 'archived-state-unavailable', stage: 'preflight' })
}

export async function listUnarchivedWorkspaceSessions({ listWorkspaces, workspacePath, archivedSessionIds, excludeSessionIds = [] } = {}) {
  if (typeof listWorkspaces !== 'function') throw new TypeError('listWorkspaces must be a function')
  const workspaces = await listWorkspaces()
  if (!Array.isArray(workspaces)) throw new TypeError('workspaces/list must resolve to an array')
  const target = normalizePath(workspacePath)
  const workspace = workspaces.find((item) => normalizePath(item && item.path) === target)
  if (!workspace || !Array.isArray(workspace.sessionIds)) return []

  let archived = archivedSessionIds
  if (typeof archived === 'function') archived = await archived()
  if (!Array.isArray(archived)) throw new TypeError('archivedSessionIds must resolve to an array')
  const excluded = new Set([...(Array.isArray(excludeSessionIds) ? excludeSessionIds : []), ...archived].map(String))
  return workspace.sessionIds.map(String).filter((id) => !excluded.has(id))
}

export async function listAfterFreshArchiveState({ refreshArchived, archivedFresh, ...options } = {}) {
  await requireFreshArchiveState(refreshArchived, archivedFresh)
  return listUnarchivedWorkspaceSessions(options)
}

export async function archiveSessions(ids, archiveSession) {
  if (!Array.isArray(ids)) throw new TypeError('ids must be an array')
  if (typeof archiveSession !== 'function') throw new TypeError('archiveSession must be a function')
  const archivedIds = []
  const failedIds = []
  for (const value of ids) {
    const id = String(value)
    try { await archiveSession(id); archivedIds.push(id) }
    catch { failedIds.push(id) }
  }
  return { archivedIds, failedIds }
}

/** Preserve every chat mapping that points at a session whose archive was not acknowledged. */
export function retainChatsForUnarchivedSessions(chats, failedIds) {
  const failed = new Set((Array.isArray(failedIds) ? failedIds : []).map(String))
  return Object.fromEntries(Object.entries(chats || {}).filter(([, entry]) => failed.has(String(entry && entry.sessionId || ''))))
}

export async function resetWorkspaceSessions({ chats = {}, looseSessionIds = [], archiveSession } = {}) {
  if (!chats || typeof chats !== 'object' || Array.isArray(chats)) throw new TypeError('chats must be an object')
  if (!Array.isArray(looseSessionIds)) throw new TypeError('looseSessionIds must be an array')
  const mappedIds = Object.values(chats).map((entry) => String(entry && entry.sessionId || '')).filter(Boolean)
  const sessionIds = [...new Set([...mappedIds, ...looseSessionIds.map(String)])]
  const result = await archiveSessions(sessionIds, archiveSession)
  return {
    ...result,
    archived: result.archivedIds.length,
    failed: result.failedIds.length,
    chats: retainChatsForUnarchivedSessions(chats, result.failedIds),
  }
}
