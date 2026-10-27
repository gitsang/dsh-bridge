/**
 * Host half of dsh-bridge v2.
 *
 * The bridge is a path-prefix gateway in front of one or more complete dsh
 * Hosts. Every backend keeps dsh's own browser UI, Session API, plugin set and
 * authentication; the gateway only mounts each backend under `/b/<id>/` and
 * forwards HTTP and WebSocket traffic after its own password gate.
 */
import { BridgeGateway } from './gateway.js'
import { configPath, defaultConfig, normalizeBridge, normalizeConfig, normalizeUpstream, readConfig, removeBridge, upsertBridge, writeConfig } from './config.js'
import { authorityOf, exchangeLaunchToken } from './upstream-auth.js'
import { MOUNT_PREFIX, mountLocation, parseMount, upstreamHeaders } from './proxy.js'
import { renderShell } from './shell.js'

export const name = 'bridge'
export const inject = ['webServer']

export { BridgeGateway }
export {
  configPath,
  defaultConfig,
  normalizeBridge,
  normalizeConfig,
  normalizeUpstream,
  readConfig,
  removeBridge,
  upsertBridge,
  writeConfig,
  authorityOf,
  exchangeLaunchToken,
  MOUNT_PREFIX,
  mountLocation,
  parseMount,
  upstreamHeaders,
  renderShell,
}

/**
 * Start the gateway beside dsh web.
 * @param {object} ctx - Cordis context providing `webServer`.
 * @param {object} config - optional gateway configuration.
 * @returns {Promise<BridgeGateway>} the started gateway.
 */
export async function apply(ctx, config = {}) {
  const gateway = await new BridgeGateway(ctx, config).start()
  ctx.effect(() => () => gateway.close(), 'bridge: gateway')
  ctx.bridgeGateway = gateway
  return gateway
}

export default apply
