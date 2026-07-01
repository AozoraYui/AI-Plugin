import fs from 'node:fs'
import path from 'node:path'
import { Config } from './config.js'

const COMMON_PATH_ALIASES = [
    { keywords: ['日志', 'log', '控制台日志'], paths: [path.join(process.cwd(), 'log.txt'), path.resolve(process.cwd(), '..', 'log.txt')] },
    { keywords: ['插件目录', '当前插件', 'ai-plugin', 'AI-Plugin'], paths: [path.join(process.cwd(), 'plugins', 'AI-Plugin'), process.cwd()] },
    { keywords: ['配置', '配置文件', 'config'], paths: [path.join(process.cwd(), 'plugins', 'AI-Plugin', 'config'), path.join(process.cwd(), 'config')] },
    { keywords: ['模型配置', 'models_config'], paths: [path.join(process.cwd(), 'plugins', 'AI-Plugin', 'config', 'models_config.yaml'), path.join(process.cwd(), 'config', 'models_config.yaml')] },
    { keywords: ['白名单', 'file_roots'], paths: [path.join(process.cwd(), 'plugins', 'AI-Plugin', 'config', 'file_roots.yaml'), path.join(process.cwd(), 'config', 'file_roots.yaml')] },
    { keywords: ['云崽data', 'yunzai data', 'data目录'], paths: [path.join(process.cwd(), 'data'), '/root/Yunzai/data'] },
]

const lastResolvedPaths = new Map()

function getContextKey(context = {}) {
    if (context.userId) {
        return context.groupId ? `${context.groupId}:${context.userId}` : String(context.userId)
    }
    return 'global'
}

function getLastResolvedPath(context = {}) {
    return lastResolvedPaths.get(getContextKey(context)) || null
}

function setLastResolvedPath(context = {}, filePath) {
    if (filePath) lastResolvedPaths.set(getContextKey(context), filePath)
}

export function resolvePathInput(inputPath, context = {}) {
    if (!inputPath || typeof inputPath !== 'string') return inputPath

    const raw = inputPath.trim()
    if (!raw) return raw

    const lastResolvedPath = getLastResolvedPath(context)

    if (path.isAbsolute(raw)) {
        return raw
    }

    if (lastResolvedPath && /(上次|刚才|之前|那个|这个|它)/.test(raw)) {
        return lastResolvedPath
    }

    const matchedAlias = COMMON_PATH_ALIASES.find(alias => alias.keywords.some(keyword => raw.includes(keyword)))
    if (matchedAlias) {
        const existingPath = matchedAlias.paths.find(p => fs.existsSync(p))
        if (existingPath) return existingPath
        if (matchedAlias.paths.length > 0) return matchedAlias.paths[0]
    }

    if (!path.isAbsolute(raw)) {
        if (lastResolvedPath) {
            const baseDir = fs.existsSync(lastResolvedPath) && fs.statSync(lastResolvedPath).isDirectory()
                ? lastResolvedPath
                : path.dirname(lastResolvedPath)
            const fromLast = path.resolve(baseDir, raw)
            if (fs.existsSync(fromLast)) {
                return fromLast
            }
        }

        return path.resolve(process.cwd(), raw)
    }

    return raw
}

export function findFuzzyPathInAllowedRoots(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return null

    const query = path.basename(inputPath.trim()).toLowerCase().replace(/(目录|文件)$/g, '')
    if (!query) return null

    const roots = Config.FILE_ROOTS
    if (!Array.isArray(roots) || roots.length === 0) return null

    const ignoredDirs = new Set(['node_modules'])
    const maxDepth = Config.FILE_FUZZY_SEARCH_MAX_DEPTH || 5
    const maxVisited = Config.FILE_FUZZY_SEARCH_MAX_VISITED || 3000

    let visited = 0
    let exactMatch = null
    let fuzzyMatch = null

    function walk(dir, depth = 0) {
        if (visited >= maxVisited || depth > maxDepth || exactMatch) return

        let entries
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }

        for (const entry of entries) {
            if (visited >= maxVisited || exactMatch) return

            const fullPath = path.join(dir, entry.name)
            const name = entry.name.toLowerCase()

            if (entry.isFile()) {
                visited++
                if (name === query) {
                    exactMatch = fullPath
                    return
                }
                if (!fuzzyMatch && name.includes(query)) {
                    fuzzyMatch = fullPath
                }
            } else if (entry.isDirectory()) {
                if (ignoredDirs.has(entry.name)) continue
                visited++
                if (name === query) {
                    exactMatch = fullPath
                    return
                }
                if (!fuzzyMatch && name.includes(query)) {
                    fuzzyMatch = fullPath
                }
                walk(fullPath, depth + 1)
            }
        }
    }

    for (const root of roots) {
        const realRoot = path.resolve(root)
        if (!fs.existsSync(realRoot)) continue

        try {
            const stat = fs.statSync(realRoot)
            if (stat.isFile()) {
                const name = path.basename(realRoot).toLowerCase()
                if (name === query) return realRoot
                if (!fuzzyMatch && name.includes(query)) fuzzyMatch = realRoot
            } else if (stat.isDirectory()) {
                walk(realRoot)
            }
        } catch { /* ignore */ }

        if (exactMatch) return exactMatch
    }

    return exactMatch || fuzzyMatch
}

export function checkPathAllowed(filePath) {
    const roots = Config.FILE_ROOTS
    if (!Array.isArray(roots) || roots.length === 0) {
        return { allowed: false, reason: '未配置文件白名单(FILE_ROOTS)' }
    }

    let realPath
    try {
        realPath = fs.realpathSync(filePath)
    } catch (err) {
        return { allowed: false, reason: `无法解析真实路径: ${err.message}` }
    }

    for (const root of roots) {
        let realRoot
        try {
            realRoot = fs.realpathSync(root)
        } catch {
            continue
        }
        if (realPath === realRoot || realPath.startsWith(realRoot + path.sep)) {
            return { allowed: true, realPath }
        }
    }

    return { allowed: false, reason: `路径不在白名单内: ${realPath}` }
}

export function rememberResolvedPath(context = {}, filePath) {
    setLastResolvedPath(context, filePath)
}
