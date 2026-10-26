import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_LOG_DIR = path.join(PLUGIN_DIR, 'logs')
const LOG_FILE_PREFIX = 'ai-plugin.'
const LOG_RETENTION_DAYS = 180
const MAX_LOG_ENTRY_CHARS = 24000
const LEVEL_NAMES = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark'])
const SECRET_KEY_PATTERN = /^(?:api[ _-]?key|key|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|token|authorization|auth|bearer|password|passwd|client[_-]?secret|secret|cookie|set-cookie|rkey|signature|sig)$/i
const SECRET_ASSIGNMENT_PATTERN = /(["']?(?:api[ _-]?key|key|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|token|authorization|auth|bearer|password|passwd|client[_-]?secret|secret|cookie|set-cookie|rkey|signature|sig)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+[^\s,;&}]+|[^"'\s,;&}\]]+)/gi
const COOKIE_HEADER_PATTERN = /(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\r\n]+)/gi
const URL_SECRET_QUERY_PATTERN = /([?&](?:api[ _-]?key|key|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|token|authorization|password|passwd|secret|cookie|rkey|signature|sig)=)[^&#\s]+/gi
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g
const DATA_BASE64_PATTERN = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,([a-z0-9+/=_-]+)/gi
const BASE64_URI_PATTERN = /base64:\/\/([a-z0-9+/_=-]+)/gi
const RAW_BASE64_PATTERN = /(?<![a-z0-9+/_=-])[a-z0-9+/_-]{512,}={0,2}(?![a-z0-9+/_=-])/gi
const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
})
const TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
})

function getBeijingDate(date) {
    return DATE_FORMATTER.format(date)
}

function getBeijingTime(date) {
    const time = TIME_FORMATTER.format(date)
    return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

function estimateBase64Bytes(value) {
    const normalized = String(value || '').replace(/\s/g, '')
    return Math.floor(normalized.length * 3 / 4) - (normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0)
}

function replaceBase64Payload(value) {
    return String(value)
        .replace(DATA_BASE64_PATTERN, (match, mimeType, payload) => {
            const mediaType = mimeType || 'binary'
            return `[${mediaType} base64 omitted: ${estimateBase64Bytes(payload)} bytes]`
        })
        .replace(BASE64_URI_PATTERN, (match, payload) => `[base64 payload omitted: ${estimateBase64Bytes(payload)} bytes]`)
        .replace(RAW_BASE64_PATTERN, payload => `[base64 payload omitted: ${estimateBase64Bytes(payload)} bytes]`)
}

export function sanitizeLogText(value) {
    return replaceBase64Payload(String(value ?? ''))
        .replace(COOKIE_HEADER_PATTERN, '$1[REDACTED]')
        .replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]')
        .replace(URL_SECRET_QUERY_PATTERN, '$1[REDACTED]')
        .replace(/\bsk-[a-z0-9_-]{16,}\b/gi, '[REDACTED_API_KEY]')
        .replace(/\bAIza[a-z0-9_-]{20,}\b/gi, '[REDACTED_API_KEY]')
        .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[REDACTED]@')
        .replace(ANSI_PATTERN, '')
}

export function formatLogPreview(value, maxChars = 1000) {
    const text = sanitizeLogText(String(value ?? '')).replace(/\s+/g, ' ').trim()
    if (!text) return '[无文本输入]'
    const limit = Math.max(1, Math.floor(Number(maxChars) || 1000))
    const characters = Array.from(text)
    if (characters.length <= limit) return text
    return `${characters.slice(0, limit).join('')}…[原文共 ${characters.length} 字]`
}

export function formatLogValueSummary(value) {
    if (value === null || value === undefined) return 'empty'
    if (typeof value === 'string') return `text:${value.length} code units`
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `binary:${value.byteLength} bytes`
    if (value instanceof ArrayBuffer) return `binary:${value.byteLength} bytes`
    if (Array.isArray(value)) return `array:${value.length} items`
    if (typeof value === 'object') {
        try {
            return `object:${Object.keys(value).length} fields`
        } catch {
            return 'object:unknown fields'
        }
    }
    return typeof value
}

function sanitizeStructuredValue(value, key = '', seen = new WeakSet()) {
    if (SECRET_KEY_PATTERN.test(String(key))) return '[REDACTED]'
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value === 'string') return sanitizeLogText(value)
    if (typeof value === 'bigint') return String(value)
    if (typeof value === 'symbol') return String(value)
    if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`
    if (Buffer.isBuffer(value)) return `[binary payload omitted: ${value.byteLength} bytes]`
    if (ArrayBuffer.isView(value)) return `[binary payload omitted: ${value.byteLength} bytes]`
    if (value instanceof ArrayBuffer) return `[binary payload omitted: ${value.byteLength} bytes]`
    if (value instanceof Error) return sanitizeLogText(value.stack || `${value.name}: ${value.message}`)
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) return value.map(item => sanitizeStructuredValue(item, '', seen))

    const output = {}
    for (const [entryKey, entryValue] of Object.entries(value)) {
        output[entryKey] = sanitizeStructuredValue(entryValue, entryKey, seen)
    }
    return output
}

function formatLogArguments(args) {
    const safeArgs = args.map(value => {
        if (typeof value === 'string') return sanitizeLogText(value)
        if (value instanceof Error) return sanitizeStructuredValue(value)
        if (value && typeof value === 'object') {
            try {
                return JSON.stringify(sanitizeStructuredValue(value))
            } catch {
                return '[unserializable object omitted]'
            }
        }
        return sanitizeStructuredValue(value)
    })
    let message = sanitizeLogText(format(...safeArgs))
    if (message.length > MAX_LOG_ENTRY_CHARS) {
        const omitted = message.length - MAX_LOG_ENTRY_CHARS
        message = `${Array.from(message).slice(0, MAX_LOG_ENTRY_CHARS).join('')}\n[log entry truncated: ${omitted} characters omitted]`
    }
    return message.replace(/\r\n?/g, '\n')
}

function createTimestampedRecord(level, args, date) {
    const message = formatLogArguments(args)
    const prefix = `[${getBeijingTime(date)}][${level.toUpperCase().padStart(4)}] `
    return `${message.split('\n').map((line, index) => index === 0 ? `${prefix}${line}` : `  ${line}`).join('\n')}\n`
}

function warnConsoleOnce(getConsoleLogger, message) {
    try {
        getConsoleLogger()?.warn?.(`[AI-Plugin] ${message}`)
    } catch {
        // Logging failures must never interrupt plugin work.
    }
}

function compressLogFile(filePath, onFailure) {
    return new Promise(resolve => {
        let child
        try {
            child = spawn('zstd', ['-q', '-f', filePath, '-o', `${filePath}.zst`], { stdio: 'ignore' })
        } catch (error) {
            onFailure(error)
            resolve(false)
            return
        }
        child.once('error', error => {
            onFailure(error)
            resolve(false)
        })
        child.once('close', code => {
            if (code !== 0) {
                onFailure(new Error(`zstd exited with code ${code}`))
                resolve(false)
                return
            }
            const compressedPath = `${filePath}.zst`
            fs.promises.chmod(compressedPath, 0o600)
                .then(() => fs.promises.unlink(filePath))
                .then(() => resolve(true))
                .catch(error => {
                    fs.promises.unlink(compressedPath).catch(() => {})
                    onFailure(error)
                    resolve(false)
                })
        })
    })
}

function parseLogDate(filename) {
    const match = filename.match(/^ai-plugin\.(\d{4}-\d{2}-\d{2})\.log(?:\.zst)?$/)
    return match?.[1] || ''
}

export function createPluginLogger({
    logDir = DEFAULT_LOG_DIR,
    getConsoleLogger = () => globalThis.logger,
    clock = () => new Date(),
    compressor = compressLogFile,
    retentionDays = LOG_RETENTION_DAYS
} = {}) {
    let stream = null
    let streamDate = ''
    let writeFailureReported = false
    let compressionFailureReported = false
    let maintenanceStarted = false
    const pendingWrites = new Set()

    const onCompressionFailure = error => {
        if (compressionFailureReported) return
        compressionFailureReported = true
        warnConsoleOnce(getConsoleLogger, `历史日志压缩失败，保留未压缩文件: ${error?.message || String(error)}`)
    }

    const archiveFile = filePath => Promise.resolve(compressor(filePath, onCompressionFailure))
        .catch(onCompressionFailure)

    const startMaintenance = today => {
        if (maintenanceStarted) return
        maintenanceStarted = true
        fs.promises.readdir(logDir, { withFileTypes: true }).then(async entries => {
            const cutoff = new Date(`${today}T00:00:00+08:00`).getTime() - retentionDays * 86400000
            for (const entry of entries) {
                if (!entry.isFile()) continue
                const date = parseLogDate(entry.name)
                if (!date || date >= today) continue
                const fullPath = path.join(logDir, entry.name)
                const fileDate = new Date(`${date}T00:00:00+08:00`).getTime()
                if (fileDate < cutoff) {
                    await fs.promises.unlink(fullPath).catch(() => {})
                } else if (entry.name.endsWith('.log')) {
                    await archiveFile(fullPath)
                }
            }
        }).catch(() => {})
    }

    const disableFileLogging = error => {
        if (writeFailureReported) return
        writeFailureReported = true
        stream = null
        warnConsoleOnce(getConsoleLogger, `插件日志文件不可用，继续输出到云崽日志: ${error?.message || String(error)}`)
    }

    const openStream = date => {
        if (stream && streamDate === date) return stream
        const previousStream = stream
        const previousDate = streamDate
        stream = null
        streamDate = date
        if (previousStream) {
            previousStream.end(() => {
                if (previousDate) archiveFile(path.join(logDir, `${LOG_FILE_PREFIX}${previousDate}.log`))
            })
        }
        try {
            fs.mkdirSync(logDir, { recursive: true, mode: 0o700 })
            fs.chmodSync(logDir, 0o700)
            const filePath = path.join(logDir, `${LOG_FILE_PREFIX}${date}.log`)
            const nextStream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 })
            nextStream.on('open', () => {
                try {
                    fs.chmodSync(filePath, 0o600)
                } catch (error) {
                    if (stream === nextStream) disableFileLogging(error)
                }
            })
            nextStream.on('error', error => {
                if (stream === nextStream) disableFileLogging(error)
                else warnConsoleOnce(getConsoleLogger, `历史日志流关闭异常: ${error?.message || String(error)}`)
            })
            stream = nextStream
            startMaintenance(date)
            return stream
        } catch (error) {
            disableFileLogging(error)
            return null
        }
    }

    const writeFileRecord = (level, args) => {
        if (writeFailureReported) return
        const now = clock()
        const date = getBeijingDate(now)
        const activeStream = openStream(date)
        if (!activeStream) return
        try {
            const record = createTimestampedRecord(level, args, now)
            let pending
            pending = new Promise(resolve => {
                activeStream.write(record, error => {
                    if (error) disableFileLogging(error)
                    resolve()
                })
            }).finally(() => pendingWrites.delete(pending))
            pendingWrites.add(pending)
        } catch (error) {
            disableFileLogging(error)
        }
    }

    const emit = (level, args) => {
        const safeArgs = args.map(value => {
            if (typeof value === 'string') return sanitizeLogText(value)
            if (value instanceof Error || (value && typeof value === 'object')) return sanitizeStructuredValue(value)
            return value
        })
        try {
            const consoleLogger = getConsoleLogger()
            const method = consoleLogger?.[level]
            if (typeof method === 'function') method.apply(consoleLogger, safeArgs)
        } catch {
            // The console logger is an optional adapter and must not interrupt plugin work.
        }
        writeFileRecord(level, safeArgs)
    }

    const facade = new Proxy({}, {
        get(_target, property) {
            if (property === 'flush') return async () => Promise.all([...pendingWrites])
            if (property === 'close') return async () => {
                const activeStream = stream
                stream = null
                if (!activeStream) return
                await new Promise(resolve => activeStream.end(resolve))
            }
            if (typeof property !== 'string') return undefined
            if (LEVEL_NAMES.has(property)) return (...args) => emit(property, args)
            const consoleLogger = getConsoleLogger()
            const method = consoleLogger?.[property]
            return typeof method === 'function' ? method.bind(consoleLogger) : undefined
        }
    })
    return facade
}

export const pluginLogger = createPluginLogger()
