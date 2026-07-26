import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'yaml'
import { toolRegistry } from './registry.js'

const MAX_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_READ_CHARS = 30000

function parseKeyPath(value = '') {
    const raw = String(value || '').trim()
    if (!raw) return []
    if (raw.startsWith('/')) {
        return raw.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    }
    const parts = []
    raw.replace(/(?:^|\.)([^.[\]]+)|\[(?:(\d+)|["']([^"']+)["'])\]/g, (_, dotted, index, quoted) => {
        parts.push(index !== undefined ? Number(index) : (quoted ?? dotted))
        return ''
    })
    return parts
}

function inferFormat(filePath, requested = 'auto') {
    if (requested && requested !== 'auto') return requested
    return /\.json$/i.test(filePath) ? 'json' : 'yaml'
}

function jsonEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right)
}

function nodeValue(node) {
    if (node === undefined || node === null) return node
    return typeof node.toJSON === 'function' ? node.toJSON() : node
}

function resolveYamlSegments(document, segments) {
    const resolved = []
    let current = document.contents
    for (const segment of segments) {
        if (yaml.isMap(current)) {
            const pair = current.items.find(item => String(nodeValue(item.key)) === String(segment))
            if (pair) {
                resolved.push(nodeValue(pair.key))
                current = pair.value
                continue
            }
        } else if (yaml.isSeq(current) && typeof segment === 'number') {
            resolved.push(segment)
            current = current.items[segment]
            continue
        }
        resolved.push(segment)
        current = undefined
    }
    return resolved
}

function formatPreview(value, limit = 12000) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）` : text
}

async function resolveTarget(filePath) {
    const requested = path.resolve(String(filePath || ''))
    const stats = await fs.stat(requested)
    if (!stats.isFile()) throw new Error('目标不是普通文件')
    if (stats.size > MAX_CONFIG_BYTES) throw new Error(`配置文件过大，超过 ${MAX_CONFIG_BYTES} 字节安全上限`)
    return { requested, realPath: await fs.realpath(requested), stats }
}

function parseConfig(content, format) {
    if (format === 'json') return { value: JSON.parse(content), documents: null }
    const documents = yaml.parseAllDocuments(content)
    const errors = documents.flatMap(doc => doc.errors || [])
    if (errors.length > 0) throw new Error(errors.map(error => error.message).join('；'))
    return { value: documents[0]?.toJS() ?? null, documents }
}

function getObjectPath(root, segments) {
    let current = root
    for (const segment of segments) {
        if (current === null || current === undefined || !(segment in Object(current))) return undefined
        current = current[segment]
    }
    return current
}

function setObjectPath(root, segments, value, createMissing) {
    if (segments.length === 0) return value
    let current = root
    for (let index = 0; index < segments.length - 1; index++) {
        const segment = segments[index]
        const next = segments[index + 1]
        if (current[segment] === undefined) {
            if (!createMissing) throw new Error(`路径不存在：${segments.slice(0, index + 1).join('.')}`)
            current[segment] = typeof next === 'number' ? [] : {}
        }
        current = current[segment]
        if (!current || typeof current !== 'object') throw new Error(`路径不是可写容器：${segments.slice(0, index + 1).join('.')}`)
    }
    current[segments.at(-1)] = value
    return root
}

function deleteObjectPath(root, segments) {
    if (segments.length === 0) throw new Error('不能删除配置根节点')
    const parent = getObjectPath(root, segments.slice(0, -1))
    if (!parent || typeof parent !== 'object') return false
    const key = segments.at(-1)
    if (!(key in parent)) return false
    Array.isArray(parent) && typeof key === 'number' ? parent.splice(key, 1) : delete parent[key]
    return true
}

function applyObjectUpdate(root, segments, operation, value, createMissing) {
    const before = getObjectPath(root, segments)
    if (operation === 'set') {
        const nextRoot = setObjectPath(root, segments, value, createMissing)
        return { root: nextRoot, before, after: value, changed: !jsonEqual(before, value) }
    }
    if (operation === 'delete') {
        const changed = deleteObjectPath(root, segments)
        return { root, before, after: undefined, changed }
    }
    if (!Array.isArray(before)) {
        if (before === undefined && operation === 'append' && createMissing) {
            const nextRoot = setObjectPath(root, segments, [value], true)
            return { root: nextRoot, before, after: [value], changed: true }
        }
        throw new Error(`目标路径不是数组，无法执行 ${operation}`)
    }
    if (operation === 'append') {
        if (before.some(item => jsonEqual(item, value))) return { root, before, after: before, changed: false }
        before.push(value)
        return { root, before: before.slice(0, -1), after: before, changed: true }
    }
    const filtered = before.filter(item => !jsonEqual(item, value))
    if (filtered.length === before.length) return { root, before, after: before, changed: false }
    setObjectPath(root, segments, filtered, false)
    return { root, before, after: filtered, changed: true }
}

function applyYamlUpdate(document, segments, operation, value, createMissing) {
    const resolvedSegments = resolveYamlSegments(document, segments)
    const beforeNode = document.getIn(resolvedSegments, true)
    const before = nodeValue(beforeNode)
    if (operation === 'set') {
        if (beforeNode === undefined && !createMissing) {
            const parent = document.getIn(resolvedSegments.slice(0, -1), true)
            if (segments.length > 1 && parent === undefined) throw new Error(`路径不存在：${segments.slice(0, -1).join('.')}`)
        }
        if (jsonEqual(before, value)) return { before, after: before, changed: false }
        document.setIn(resolvedSegments, value)
        return { before, after: value, changed: true }
    }
    if (operation === 'delete') {
        if (beforeNode === undefined) return { before, after: undefined, changed: false }
        document.deleteIn(resolvedSegments)
        return { before, after: undefined, changed: true }
    }
    if (beforeNode === undefined && operation === 'append' && createMissing) {
        document.setIn(resolvedSegments, [value])
        return { before, after: [value], changed: true }
    }
    if (!yaml.isSeq(beforeNode)) throw new Error(`目标路径不是数组，无法执行 ${operation}`)
    const index = beforeNode.items.findIndex(item => jsonEqual(nodeValue(item), value))
    if (operation === 'append') {
        if (index >= 0) return { before, after: before, changed: false }
        beforeNode.add(value)
        return { before, after: nodeValue(beforeNode), changed: true }
    }
    if (index < 0) return { before, after: before, changed: false }
    beforeNode.delete(index)
    return { before, after: nodeValue(beforeNode), changed: true }
}

function serializeConfig(root, format, original, documents, documentIndex) {
    if (format === 'json') {
        const indent = /^\s+"/m.exec(original)?.[0]?.length || 2
        return `${JSON.stringify(root, null, Math.min(Math.max(indent, 2), 8))}\n`
    }
    return documents.map(doc => doc.toString()).join('---\n')
}

async function atomicWrite(filePath, content, stats, makeBackup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = makeBackup ? `${filePath}.bak.${stamp}` : ''
    if (backupPath) await fs.copyFile(filePath, backupPath)
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    try {
        await fs.writeFile(tempPath, content, { mode: stats.mode })
        await fs.chmod(tempPath, stats.mode)
        await fs.chown(tempPath, stats.uid, stats.gid).catch(() => {})
        await fs.rename(tempPath, filePath)
    } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {})
        throw error
    }
    return backupPath
}

export const configManageTool = {
    name: 'config_manage',
    permission: 'master',
    description: '结构化读取、查询、校验或原子更新服务器 YAML/JSON 配置文件。支持路径级 set/append/remove/delete，自动去重、备份并重新解析验证。',
    functionSchema: {
        type: 'function',
        function: {
            name: 'config_manage',
            description: '安全管理 YAML/JSON 配置文件，优先替代模型生成的 sed、Python 或任意 Shell 文本修改。',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['read', 'get', 'validate', 'update'], description: '读取全文、读取指定路径、校验语法或更新配置。' },
                    path: { type: 'string', description: '配置文件绝对路径或基于插件工作目录的相对路径。' },
                    format: { type: 'string', enum: ['auto', 'yaml', 'json'], description: '默认 auto，根据扩展名判断。' },
                    key_path: { type: 'string', description: '配置路径，支持 groups.710024443.disable、items[0].name 或 JSON Pointer /groups/710024443/disable。' },
                    operation: { type: 'string', enum: ['set', 'append', 'remove', 'delete'], description: 'action=update 时的更新动作。' },
                    value: { description: 'set/append/remove 使用的 JSON 值；字符串也必须作为字符串传入。' },
                    create_missing: { type: 'boolean', description: '路径不存在时是否创建，默认 false。' },
                    backup: { type: 'boolean', description: '更新前是否创建时间戳备份，默认 true。' },
                    document_index: { type: 'number', description: '多文档 YAML 的文档序号，默认 0。' }
                },
                required: ['action', 'path']
            }
        }
    },
    validateArgs(args = {}) {
        const action = String(args.action || '').trim()
        if (!['read', 'get', 'validate', 'update'].includes(action) || !String(args.path || '').trim()) return false
        if (args.format && !['auto', 'yaml', 'json'].includes(args.format)) return false
        if (['get', 'update'].includes(action) && !String(args.key_path || '').trim()) return false
        if (action === 'update') {
            if (!['set', 'append', 'remove', 'delete'].includes(args.operation)) return false
            if (args.operation !== 'delete' && !Object.prototype.hasOwnProperty.call(args, 'value')) return false
        }
        return true
    },
    async execute(args = {}) {
        const action = String(args.action || '').trim()
        if (!['read', 'get', 'validate', 'update'].includes(action)) return { ok: false, error: 'action 必须是 read/get/validate/update。' }
        if (!args.path) return { ok: false, error: '缺少配置文件 path。' }

        try {
            const target = await resolveTarget(args.path)
            const format = inferFormat(target.realPath, args.format)
            const content = await fs.readFile(target.realPath, 'utf8')
            const parsed = parseConfig(content, format)
            const documentIndex = Math.max(0, Number(args.document_index) || 0)
            if (format === 'yaml' && !parsed.documents[documentIndex]) return { ok: false, error: `YAML 不存在第 ${documentIndex} 个文档。`, recoverable: true }
            const root = format === 'yaml' ? parsed.documents[documentIndex].toJS() : parsed.value

            if (action === 'validate') {
                return { ok: true, action, path: target.realPath, format, verified: true, summary: `${format.toUpperCase()} 语法校验通过` }
            }
            if (action === 'read') {
                const text = content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n…（已截断，共 ${content.length} 字符）` : content
                return { ok: true, action, path: target.realPath, format, verified: true, truncated: content.length > MAX_READ_CHARS, content: text, summary: `已读取配置文件，共 ${content.length} 字符` }
            }

            const segments = parseKeyPath(args.key_path)
            if (segments.length === 0) return { ok: false, error: `${action} 操作需要 key_path。`, recoverable: true }
            if (action === 'get') {
                const value = getObjectPath(root, segments)
                if (value === undefined) return { ok: false, error: `配置路径不存在：${args.key_path}`, recoverable: true }
                return { ok: true, action, path: target.realPath, format, keyPath: args.key_path, value, verified: true, summary: `已读取配置路径 ${args.key_path}` }
            }

            const operation = String(args.operation || '').trim()
            if (!['set', 'append', 'remove', 'delete'].includes(operation)) return { ok: false, error: 'update 操作需要 operation=set/append/remove/delete。', recoverable: true }
            if (operation !== 'delete' && !Object.prototype.hasOwnProperty.call(args, 'value')) return { ok: false, error: `${operation} 操作缺少 value。`, recoverable: true }

            const update = format === 'yaml'
                ? applyYamlUpdate(parsed.documents[documentIndex], segments, operation, args.value, args.create_missing === true)
                : applyObjectUpdate(root, segments, operation, args.value, args.create_missing === true)
            if (!update.changed) {
                return { ok: true, action, operation, path: target.realPath, format, keyPath: args.key_path, changed: false, verified: true, before: update.before, after: update.after, summary: `目标配置已经是期望状态，无需写入` }
            }

            const nextContent = serializeConfig(update.root || root, format, content, parsed.documents, documentIndex)
            parseConfig(nextContent, format)
            const backupPath = await atomicWrite(target.realPath, nextContent, target.stats, args.backup !== false)
            const verifiedContent = await fs.readFile(target.realPath, 'utf8')
            const verifiedParsed = parseConfig(verifiedContent, format)
            const verifiedRoot = format === 'yaml' ? verifiedParsed.documents[documentIndex].toJS() : verifiedParsed.value
            const verifiedValue = getObjectPath(verifiedRoot, segments)
            const expected = operation === 'delete' ? undefined : update.after
            const verified = operation === 'delete' ? verifiedValue === undefined : jsonEqual(verifiedValue, expected)
            if (!verified) throw new Error('写入后目标值校验失败')

            return {
                ok: true,
                action,
                operation,
                path: target.realPath,
                format,
                keyPath: args.key_path,
                changed: true,
                verified: true,
                backupPath,
                before: update.before,
                after: verifiedValue,
                summary: `已原子更新 ${args.key_path}，并通过重新解析与目标值校验`
            }
        } catch (error) {
            return { ok: false, error: error.message || String(error), recoverable: /路径|不存在|缺少|不是数组/.test(error.message || '') }
        }
    },
    formatResult(data) {
        if (!data || typeof data !== 'object') return String(data || '')
        if (!data.ok) return `\n\n【结构化配置操作失败】\n${data.error || '未知错误'}\n【结构化配置结果结束】\n`
        let output = `\n\n【结构化配置结果】\n操作: ${data.action}${data.operation ? `/${data.operation}` : ''}\n文件: ${data.path}\n状态: 成功\n校验: ${data.verified ? '通过' : '未通过'}\n说明: ${data.summary || ''}`
        if (data.keyPath) output += `\n配置路径: ${data.keyPath}`
        if (Object.prototype.hasOwnProperty.call(data, 'value')) output += `\n值:\n${formatPreview(data.value)}`
        if (Object.prototype.hasOwnProperty.call(data, 'before')) output += `\n修改前:\n${formatPreview(data.before)}`
        if (Object.prototype.hasOwnProperty.call(data, 'after')) output += `\n修改后:\n${formatPreview(data.after)}`
        if (data.backupPath) output += `\n备份: ${data.backupPath}`
        if (data.content) output += `\n内容:\n${data.content}`
        return `${output}\n【结构化配置结果结束】\n`
    }
}

toolRegistry.register(configManageTool)
