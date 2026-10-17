import fs from 'node:fs'
import path from 'node:path'

const COMMON_PATH_ALIASES = [
    { keywords: ['日志', 'log', '控制台日志'], paths: [path.join(process.cwd(), 'log.txt'), path.resolve(process.cwd(), '..', 'log.txt')] },
    { keywords: ['插件目录', '当前插件', 'ai-plugin', 'AI-Plugin'], paths: [path.join(process.cwd(), 'plugins', 'AI-Plugin'), process.cwd()] },
    { keywords: ['配置', '配置文件', 'config'], paths: [path.join(process.cwd(), 'plugins', 'AI-Plugin', 'config'), path.join(process.cwd(), 'config')] },
    { keywords: ['模型配置', 'models_config'], paths: [path.join(process.cwd(), 'plugins', 'AI-Plugin', 'config', 'models_config.yaml'), path.join(process.cwd(), 'config', 'models_config.yaml')] },
    { keywords: ['云崽data', 'yunzai data', 'data目录'], paths: [path.join(process.cwd(), 'data'), '/root/Yunzai/data'] },
]

const lastResolvedPaths = new Map()

function getContextKey(context = {}) {
    if (context.userId) return context.groupId ? `${context.groupId}:${context.userId}` : String(context.userId)
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

    if (path.isAbsolute(raw)) return raw
    if (lastResolvedPath && /(上次|刚才|之前|那个|这个|它)/.test(raw)) return lastResolvedPath

    const matchedAlias = COMMON_PATH_ALIASES.find(alias => alias.keywords.some(keyword => raw.includes(keyword)))
    if (matchedAlias) {
        const existingPath = matchedAlias.paths.find(candidate => fs.existsSync(candidate))
        if (existingPath) return existingPath
        if (matchedAlias.paths.length > 0) return matchedAlias.paths[0]
    }

    if (lastResolvedPath) {
        const baseDir = fs.existsSync(lastResolvedPath) && fs.statSync(lastResolvedPath).isDirectory()
            ? lastResolvedPath
            : path.dirname(lastResolvedPath)
        const fromLast = path.resolve(baseDir, raw)
        if (fs.existsSync(fromLast)) return fromLast
    }

    return path.resolve(process.cwd(), raw)
}

export function normalizeFuzzyFileName(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/(?:有没有|是否|名字|名称|接近|相近|类似|相关|找一下|找找|看一下|看下|看看|查一下|查找|搜索|搜一下|一个|这个|那个|刚才|上面|前面|名为|名字叫|叫做|叫|插件|源码|源文件|脚本|文件|目录|的)+/g, '')
        .replace(/\.(?:tar\.gz|[a-z0-9]{1,8})$/i, '')
        .replace(/[\s_.\-–—()（）\[\]【】'"“”‘’]+/g, '')
}

function getFuzzySearchRoots() {
    const candidates = [
        process.cwd(),
        path.resolve(process.cwd(), '..'),
        path.join(process.cwd(), 'plugins'),
        path.join(process.cwd(), 'resources'),
        path.join(process.cwd(), 'temp'),
        path.join(process.cwd(), 'data')
    ]
    return [...new Set(candidates.map(candidate => path.resolve(candidate)))].filter(candidate => fs.existsSync(candidate))
}

export function findFuzzyPathInRuntimeRoots(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return null

    const query = path.basename(inputPath.trim()).toLowerCase().replace(/(目录|文件)$/, '')
    const normalizedQuery = normalizeFuzzyFileName(query)
    if (!query) return null

    const ignoredDirs = new Set(['node_modules', '.git', 'data/chroma_db'])
    const maxDepth = 5
    const maxVisited = 3000
    let visited = 0
    let exactMatch = null
    let fuzzyMatch = null
    let fuzzyScore = Number.POSITIVE_INFINITY

    const considerFuzzyMatch = (fullPath, name) => {
        const normalizedName = normalizeFuzzyFileName(name)
        if (!normalizedQuery || !normalizedName.includes(normalizedQuery)) return
        const score = normalizedName.length - normalizedQuery.length
        if (!fuzzyMatch || score < fuzzyScore) {
            fuzzyMatch = fullPath
            fuzzyScore = score
        }
    }

    function walk(dir, depth = 0) {
        if (visited >= maxVisited || depth > maxDepth || exactMatch) return
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

        for (const entry of entries) {
            if (visited >= maxVisited || exactMatch) return
            const fullPath = path.join(dir, entry.name)
            const name = entry.name.toLowerCase()
            if (entry.isFile()) {
                visited++
                if (name === query) { exactMatch = fullPath; return }
                considerFuzzyMatch(fullPath, name)
            } else if (entry.isDirectory()) {
                if (ignoredDirs.has(entry.name)) continue
                visited++
                if (name === query) { exactMatch = fullPath; return }
                considerFuzzyMatch(fullPath, name)
                walk(fullPath, depth + 1)
            }
        }
    }

    for (const rootPath of getFuzzySearchRoots()) {
        try {
            const stat = fs.statSync(rootPath)
            if (stat.isFile()) {
                const name = path.basename(rootPath).toLowerCase()
                if (name === query) return rootPath
                considerFuzzyMatch(rootPath, name)
            } else if (stat.isDirectory()) {
                walk(rootPath)
            }
        } catch { /* ignore transient entry */ }
        if (exactMatch) return exactMatch
    }

    return exactMatch || fuzzyMatch
}

export function checkPathAllowed(filePath) {
    if (!filePath || typeof filePath !== 'string') return { allowed: false, reason: '未提供有效路径' }
    try {
        return { allowed: true, realPath: fs.realpathSync(filePath), pathPolicy: '主人权限与真实路径校验' }
    } catch (err) {
        return { allowed: false, reason: `无法解析真实路径: ${err.message}` }
    }
}

export function checkPathAllowedForWrite(filePath) {
    const targetPath = path.resolve(String(filePath || ''))
    if (!targetPath || targetPath === '.') return { allowed: false, reason: '未提供有效目标路径' }

    let existingParent = targetPath
    try {
        if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) existingParent = path.dirname(targetPath)
    } catch { existingParent = path.dirname(targetPath) }
    while (!fs.existsSync(existingParent)) {
        const parent = path.dirname(existingParent)
        if (parent === existingParent) break
        existingParent = parent
    }

    let realParent
    try { realParent = fs.realpathSync(existingParent) } catch (err) {
        return { allowed: false, reason: `无法解析目标父目录: ${err.message}` }
    }

    const relativeTail = path.relative(existingParent, targetPath)
    return {
        allowed: true,
        realPath: path.resolve(realParent, relativeTail),
        realRoot: realParent,
        pathPolicy: '主人权限与真实父目录校验'
    }
}

export function rememberResolvedPath(context = {}, filePath) {
    setLastResolvedPath(context, filePath)
}
