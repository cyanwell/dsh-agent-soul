import { resetFailure, resetSuccess } from './reset-response.mjs'

export function registerSessionResetRoute(route, hub) {
  route('/sessions/reset', async () => {
    try { return resetSuccess(await hub.resetSessions()) }
    catch (error) { return resetFailure(error) }
  })
}
