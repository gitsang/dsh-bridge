/**
 * Dialog payloads the browser renders, shared by both OpenCode generations.
 *
 * The host's UI contract is Pi's `extension_ui_request`, while OpenCode's two
 * server generations name the same permission concepts differently: 1.x sends
 * `permission`/`patterns`, 2.x sends `action`/`resources`. Both shapes reach the
 * same dialog, so the shaping lives in one module instead of once per transport.
 */

/**
 * Build the Pi-shaped extension dialog payload for one permission request.
 *
 * The v2 event family names the fields `action`/`resources` instead of
 * `permission`/`patterns`; both shapes reach the same dialog.
 */
export function permissionUiRequest(request) {
  const permission = typeof request?.permission === 'string'
    ? request.permission
    : typeof request?.action === 'string' ? request.action : 'tool'
  const patterns = Array.isArray(request?.patterns)
    ? request.patterns
    : Array.isArray(request?.resources) ? request.resources : []
  const command = request?.metadata?.command
  const detail = typeof command === 'string' && command !== ''
    ? command
    : patterns.length > 0 ? patterns.join(', ') : ''
  return {
    type: 'extension_ui_request',
    id: request.id,
    method: 'confirm',
    title: `OpenCode wants to run ${permission}`,
    message: detail === '' ? `OpenCode is asking for permission to use ${permission}.` : detail,
  }
}

/** Build the Pi-shaped extension dialog payload for one interactive question. */
export function questionUiRequest(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const first = questions[0] ?? {}
  const options = Array.isArray(first.options)
    ? first.options.map((option) => (typeof option === 'string' ? option : option?.label)).filter(Boolean)
    : []
  return {
    type: 'extension_ui_request',
    id: request.id,
    method: options.length > 0 ? 'select' : 'confirm',
    title: typeof first.header === 'string' && first.header !== '' ? first.header : 'OpenCode question',
    message: typeof first.question === 'string' && first.question !== '' ? first.question : 'OpenCode is asking a question.',
    ...(options.length === 0 ? {} : { options }),
  }
}
