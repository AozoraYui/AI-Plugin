import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { toolRegistry } from './registry.js'
import { checkPathAllowed, checkPathAllowedForWrite, rememberResolvedPath, resolvePathInput } from '../utils/file_access.js'

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'data/chroma_db'])

function resolveAllowedPath(rawPath, context = {}, write = false) {
    const resolved = path.resolve(resolvePathInput(String(rawPath || '.'), context) || '.')
    const check = write ? checkPathAllowedForWrite(resolved) : checkPathAllowed(resolved)
    if (!check.allowed) return { ok: false, error: check.reason }
    rememberResolvedPath(context, check.realPath)
    return { ok: true, path: check.realPath }
}

function runFile(command, args, options = {}) {
    return new Promise(resolve => {
        execFile(command, args, {
            cwd: options.cwd,
            timeout: options.timeout || 30000,
            maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
            windowsHide: true
        }, (error, stdout = '', stderr = '') => resolve({
            ok: !error,
            code: error?.code ?? 0,
            stdout,
            stderr,
            error: error?.message || ''
        }))
    })
}

function normalizeLimit(value, fallback, max) {
    return Math.max(1, Math.min(max, Math.floor(Number(value) || fallback)))
}

export const workspaceListTool = {
    name: 'workspace_list',
    permission: 'master',
    description: '结构化列出白名单工作区中的文件和目录，支持有限深度递归；比 Shell ls/find 更适合后续 Agent 规划。',
    functionSchema: {
        name: 'workspace_list',
        description: '列出白名单工作区目录内容。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '目录路径、相对路径或已知路径别名。' },
                depth: { type: 'integer', description: '递归深度，默认 1，最大 5。' },
                limit: { type: 'integer', description: '最多返回条目数，默认 200，最大 1000。' },
                include_hidden: { type: 'boolean', description: '是否包含隐藏文件，默认 false。' }
            },
            required: ['path']
        }
    },
    async execute(args = {}, context = {}) {
        const target = resolveAllowedPath(args.path, context)
        if (!target.ok) return { ok: false, recoverable: true, error: target.error }
        let stat
        try { stat = await fsp.stat(target.path) } catch (err) { return { ok: false, recoverable: true, error: err.message } }
        if (!stat.isDirectory()) return { ok: false, recoverable: true, error: `目标不是目录: ${target.path}` }

        const maxDepth = normalizeLimit(args.depth, 1, 5)
        const limit = normalizeLimit(args.limit, 200, 1000)
        const includeHidden = args.include_hidden === true
        const entries = []
        async function walk(directory, depth) {
            if (entries.length >= limit || depth > maxDepth) return
            const children = await fsp.readdir(directory, { withFileTypes: true })
            children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
            for (const child of children) {
                if (entries.length >= limit) break
                if (!includeHidden && child.name.startsWith('.')) continue
                if (child.isDirectory() && IGNORED_DIRS.has(child.name)) continue
                const fullPath = path.join(directory, child.name)
                let size = 0
                let mtime = ''
                try {
                    const childStat = await fsp.stat(fullPath)
                    size = childStat.size
                    mtime = childStat.mtime.toISOString()
                } catch { /* ignore transient entry */ }
                entries.push({
                    name: child.name,
                    path: fullPath,
                    relativePath: path.relative(target.path, fullPath) || '.',
                    type: child.isDirectory() ? 'directory' : (child.isFile() ? 'file' : 'other'),
                    size,
                    mtime
                })
                if (child.isDirectory() && depth < maxDepth) await walk(fullPath, depth + 1)
            }
        }
        await walk(target.path, 1)
        return {
            ok: true,
            verified: true,
            summary: `已列出 ${target.path}，返回 ${entries.length} 个条目。`,
            facts: { root: target.path, count: entries.length, truncated: entries.length >= limit },
            artifacts: entries.slice(0, 100).map(item => ({ type: item.type, path: item.path })),
            entries
        }
    },
    formatResult(data) {
        return JSON.stringify(data, null, 2)
    }
}

export const workspaceSearchTool = {
    name: 'workspace_search',
    permission: 'master',
    description: '在白名单工作区内按文件名或文本内容搜索，返回结构化路径、行号和匹配片段。',
    functionSchema: {
        name: 'workspace_search',
        description: '搜索工作区文件名或文件内容。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '搜索根目录。' },
                query: { type: 'string', description: '文件名片段或文本搜索词。' },
                mode: { type: 'string', enum: ['content', 'filename'], description: 'content 搜内容，filename 搜文件名。' },
                glob: { type: 'string', description: '可选 glob，例如 *.js。' },
                limit: { type: 'integer', description: '最多返回结果数，默认 100，最大 500。' },
                case_sensitive: { type: 'boolean', description: '是否区分大小写。' }
            },
            required: ['path', 'query', 'mode']
        }
    },
    async execute(args = {}, context = {}) {
        const target = resolveAllowedPath(args.path, context)
        if (!target.ok) return { ok: false, recoverable: true, error: target.error }
        let rootStat
        try { rootStat = await fsp.stat(target.path) } catch (err) { return { ok: false, recoverable: true, error: err.message } }
        if (!rootStat.isDirectory()) return { ok: false, recoverable: true, error: `搜索根路径不是目录: ${target.path}` }
        const query = String(args.query || '').trim()
        if (!query) return { ok: false, recoverable: true, error: '搜索词不能为空。' }
        const limit = normalizeLimit(args.limit, 100, 500)
        const mode = args.mode === 'filename' ? 'filename' : 'content'
        const rgArgs = mode === 'filename'
            ? ['--files', '--hidden', '--glob', '!node_modules/**', '--glob', '!.git/**']
            : ['--line-number', '--column', '--no-heading', '--color', 'never', '--hidden', '--glob', '!node_modules/**', '--glob', '!.git/**']
        if (args.glob) rgArgs.push('--glob', String(args.glob))
        if (args.case_sensitive !== true && mode === 'content') rgArgs.push('--ignore-case')
        if (mode === 'content') rgArgs.push('--fixed-strings', '--', query, '.')
        else rgArgs.push('.')
        const result = await runFile('rg', rgArgs, { cwd: target.path })
        if (!result.ok && result.code !== 1) return { ok: false, recoverable: true, error: result.stderr || result.error }
        const lines = result.stdout.split('\n').filter(Boolean)
        const matches = []
        for (const line of lines) {
            if (matches.length >= limit) break
            if (mode === 'filename') {
                if (!line.toLowerCase().includes(query.toLowerCase())) continue
                matches.push({ path: path.resolve(target.path, line), relativePath: line, type: 'file' })
                continue
            }
            const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/)
            if (!match) continue
            matches.push({
                path: path.resolve(target.path, match[1]),
                relativePath: match[1],
                line: Number(match[2]),
                column: Number(match[3]),
                text: match[4].slice(0, 1000)
            })
        }
        return {
            ok: true,
            verified: true,
            summary: `工作区搜索完成，找到 ${matches.length} 条结果。`,
            facts: { root: target.path, query, mode, count: matches.length, truncated: lines.length > matches.length },
            artifacts: [...new Map(matches.map(item => [item.path, { type: 'file', path: item.path }])).values()].slice(0, 100),
            matches
        }
    },
    formatResult(data) {
        return JSON.stringify(data, null, 2)
    }
}

export const workspaceReadTool = {
    name: 'workspace_read',
    permission: 'master',
    description: '按行读取白名单工作区文件，提供稳定行号、分页和文件元信息。',
    functionSchema: {
        name: 'workspace_read',
        description: '按行读取工作区文本文件。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '文件路径。' },
                start_line: { type: 'integer', description: '起始行，默认 1。' },
                line_count: { type: 'integer', description: '读取行数，默认 200，最大 1000。' }
            },
            required: ['path']
        }
    },
    async execute(args = {}, context = {}) {
        const target = resolveAllowedPath(args.path, context)
        if (!target.ok) return { ok: false, recoverable: true, error: target.error }
        let stat
        try { stat = await fsp.stat(target.path) } catch (err) { return { ok: false, recoverable: true, error: err.message } }
        if (!stat.isFile()) return { ok: false, recoverable: true, error: `目标不是文件: ${target.path}` }
        if (stat.size > 8 * 1024 * 1024) return { ok: false, recoverable: true, error: '文件超过 8MB，请先搜索或使用 Shell 分段提取。' }
        const content = await fsp.readFile(target.path, 'utf8')
        const lines = content.split(/\r?\n/)
        const startLine = normalizeLimit(args.start_line, 1, Math.max(1, lines.length))
        const lineCount = normalizeLimit(args.line_count, 200, 1000)
        const selected = lines.slice(startLine - 1, startLine - 1 + lineCount)
        return {
            ok: true,
            verified: true,
            summary: `已读取 ${path.basename(target.path)} 第 ${startLine}-${startLine + Math.max(0, selected.length - 1)} 行。`,
            facts: { path: target.path, totalLines: lines.length, startLine, endLine: startLine + Math.max(0, selected.length - 1), hasMore: startLine - 1 + selected.length < lines.length },
            artifacts: [{ type: 'file', path: target.path }],
            content: selected.map((line, index) => `${startLine + index}: ${line}`).join('\n')
        }
    },
    formatResult(data) {
        return JSON.stringify(data, null, 2)
    }
}

export const workspacePatchTool = {
    name: 'workspace_patch',
    permission: 'master',
    description: '在白名单工作区中执行精确文本替换补丁，要求旧文本真实存在，原子写入并重新读取验证。',
    functionSchema: {
        name: 'workspace_patch',
        description: '对工作区文本文件执行精确替换。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '目标文件路径。' },
                old_text: { type: 'string', description: '必须与文件中现有内容完全一致的旧文本。' },
                new_text: { type: 'string', description: '替换后的新文本。' },
                replace_all: { type: 'boolean', description: '是否替换所有匹配；默认 false，要求唯一匹配。' }
            },
            required: ['path', 'old_text', 'new_text']
        }
    },
    async execute(args = {}, context = {}) {
        const target = resolveAllowedPath(args.path, context, true)
        if (!target.ok) return { ok: false, recoverable: true, error: target.error }
        if (!fs.existsSync(target.path)) return { ok: false, recoverable: true, error: `目标文件不存在: ${target.path}` }
        const oldText = String(args.old_text ?? '')
        const newText = String(args.new_text ?? '')
        if (!oldText) return { ok: false, recoverable: true, error: 'old_text 不能为空。' }
        const stat = await fsp.stat(target.path)
        if (!stat.isFile()) return { ok: false, recoverable: true, error: '目标不是普通文件。' }
        if (stat.size > 4 * 1024 * 1024) return { ok: false, recoverable: true, error: '文件超过 4MB，不允许直接补丁。' }
        const before = await fsp.readFile(target.path, 'utf8')
        const occurrences = before.split(oldText).length - 1
        if (occurrences === 0) return { ok: false, recoverable: true, error: '旧文本未在文件中找到，文件可能已经变化，请重新读取。' }
        if (occurrences > 1 && args.replace_all !== true) return { ok: false, recoverable: true, error: `旧文本出现 ${occurrences} 次，无法确定唯一修改位置，请扩大上下文或明确 replace_all。` }
        const after = args.replace_all === true ? before.split(oldText).join(newText) : before.replace(oldText, newText)
        if (after === before) return { ok: true, verified: true, changed: false, summary: '补丁内容没有造成变化。', facts: { path: target.path, occurrences } }
        const tempPath = `${target.path}.ai-plugin-${process.pid}-${Date.now()}.tmp`
        try {
            await fsp.writeFile(tempPath, after, { encoding: 'utf8', mode: stat.mode })
            await fsp.rename(tempPath, target.path)
        } finally {
            if (fs.existsSync(tempPath)) {
                try { await fsp.unlink(tempPath) } catch { /* ignore cleanup failure */ }
            }
        }
        const verifiedContent = await fsp.readFile(target.path, 'utf8')
        const verified = verifiedContent === after
        return {
            ok: verified,
            verified,
            changed: verified,
            recoverable: !verified,
            summary: verified ? `已精确修改 ${target.path} 并完成写后校验。` : '文件写入后校验失败。',
            error: verified ? '' : '写后内容与预期不一致。',
            facts: { path: target.path, occurrences, beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) },
            artifacts: [{ type: 'file', path: target.path, changed: verified }],
            next_hints: verified ? ['根据任务成功标准运行相关测试或查看 diff。'] : ['重新读取文件后再生成补丁。']
        }
    },
    formatResult(data) {
        return JSON.stringify(data, null, 2)
    }
}

toolRegistry.register(workspaceListTool)
toolRegistry.register(workspaceSearchTool)
toolRegistry.register(workspaceReadTool)
toolRegistry.register(workspacePatchTool)
