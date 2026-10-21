#!/usr/bin/env node
/**
 * Point the installed dsh web profile at this checkout and report the result.
 *
 * This calls the profile's own plugin manager over the authenticated API, so it
 * uses the same install path as the Web Plugins page. The browser cookie is
 * minted in memory only.
 */
import { createClient } from './lib/dsh-rpc.mjs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.DSH_PORT ?? 3080)
const client = createClient({ port })

const name = '@gitsang/dsh-bridge'
const spec = `link:${here}`

process.stdout.write(`installing ${spec} …\n`)
const installed = await client.remote('pluginManager/installBundle', { spec, options: {} }, { timeoutMs: 300_000 })
if (!installed.ok) {
  console.error(installed.error)
  process.exit(1)
}
process.stdout.write(`install: ${installed.value.application ?? installed.value.stage}\n`)

const bundles = await client.remote('pluginManager/listBundles', {})
const entry = bundles.ok ? bundles.value.find((bundle) => bundle.name === name) : undefined
if (entry === undefined) {
  console.error('bundle not listed after install')
  process.exit(1)
}
process.stdout.write(`bundle: ${entry.name}@${entry.version} enabled=${entry.enabled} installed=${entry.installed}\n`)

const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(`${here}/package.json`, 'utf8'))
process.stdout.write(`checkout: ${manifest.name}@${manifest.version} at ${here}\n`)
process.stdout.write('\nrestart `dsh web` to load the updated Host and client bundles.\n')
