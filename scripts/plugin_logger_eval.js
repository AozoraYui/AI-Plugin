import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const {
    createPluginLogger,
    sanitizeLogText
} = await import('../utils/plugin_logger.js')

const secretText = 'Authorization: Bearer bearer-secret api_key=api-secret token=token-secret'
const sanitizedSecretText = sanitizeLogText(secretText)
assert.ok(!sanitizedSecretText.includes('bearer-secret'))
assert.ok(!sanitizedSecretText.includes('api-secret'))
assert.ok(!sanitizedSecretText.includes('token-secret'))
assert.match(sanitizedSecretText, /Authorization: \[REDACTED\]/)
const plainJsonSecrets = sanitizeLogText('{"api_key":"json-secret","Cookie":"sid=cookie-secret; auth=also-secret","user_id":"956753394"}')
assert.ok(!plainJsonSecrets.includes('json-secret'))
assert.ok(!plainJsonSecrets.includes('cookie-secret'))
assert.ok(!plainJsonSecrets.includes('also-secret'))
assert.ok(plainJsonSecrets.includes('956753394'))

const imagePayload = `data:image/png;base64,${'A'.repeat(4096)}`
const sanitizedImage = sanitizeLogText(imagePayload)
assert.ok(!sanitizedImage.includes('A'.repeat(1024)))
assert.match(sanitizedImage, /\[image\/png base64 omitted: \d+ bytes\]/)

const base64Uri = `base64://${'A'.repeat(4096)}`
assert.match(sanitizeLogText(base64Uri), /\[base64 payload omitted: \d+ bytes\]/)
assert.match(sanitizeLogText('https://example.test/image?rkey=private-signature&file=1'), /rkey=\[REDACTED\]/)
assert.ok(!sanitizeLogText('https://example.test/image?rkey=private-signature&file=1').includes('private-signature'))

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-plugin-log-eval-'))
const consoleLines = []
let now = new Date('2026-10-25T12:34:56.789+08:00')
let resolveArchive
const archivedFile = new Promise(resolve => { resolveArchive = resolve })
const logger = createPluginLogger({
    logDir,
    clock: () => now,
    getConsoleLogger: () => ({
        info: (...args) => consoleLines.push(['info', ...args]),
        warn: (...args) => consoleLines.push(['warn', ...args]),
        error: (...args) => consoleLines.push(['error', ...args]),
        debug: (...args) => consoleLines.push(['debug', ...args]),
        mark: (...args) => consoleLines.push(['mark', ...args])
    }),
    compressor: async filePath => {
        resolveArchive(filePath)
        return true
    }
})

logger.info('[AI-Plugin] 群=1039793252, user=956753394, payload=', {
    qq: '956753394',
    apiKey: 'secret-object-key',
    image: imagePayload,
    raw: Buffer.from('binary image data')
})
logger.warn('Authorization: Bearer object-bearer-secret')
await logger.flush()

const currentFile = path.join(logDir, 'ai-plugin.2026-10-25.log')
const content = fs.readFileSync(currentFile, 'utf8')
assert.match(content, /群=1039793252/)
assert.match(content, /user=956753394/)
assert.ok(!content.includes('secret-object-key'))
assert.ok(!content.includes('object-bearer-secret'))
assert.ok(!content.includes('A'.repeat(1024)))
assert.ok(!content.includes('binary image data'))
assert.match(content, /binary payload omitted: \d+ bytes/)
assert.match(content, /base64 omitted: \d+ bytes/)
assert.equal(fs.statSync(logDir).mode & 0o777, 0o700)
assert.equal(fs.statSync(currentFile).mode & 0o777, 0o600)
assert.ok(consoleLines.some(line => line[0] === 'info'))
assert.ok(!JSON.stringify(consoleLines).includes('secret-object-key'))
assert.ok(!JSON.stringify(consoleLines).includes('A'.repeat(1024)))

now = new Date('2026-10-26T00:00:00.000+08:00')
logger.info('跨日轮转')
await logger.flush()
assert.ok(fs.existsSync(path.join(logDir, 'ai-plugin.2026-10-26.log')))
assert.equal(await archivedFile, path.join(logDir, 'ai-plugin.2026-10-25.log'))
await logger.close()

fs.rmSync(logDir, { recursive: true, force: true })
console.log('Plugin logger eval: passed')
