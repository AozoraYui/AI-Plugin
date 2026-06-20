/**
 * 本地文件只读 & 目录浏览工具
 * 允许 AI 读取白名单目录下的文件和目录列表（只读）
 */

import { toolRegistry } from './registry.js'
import fs from 'node:fs'
import path from 'node:path'
import { Config } from '../utils/config.js'

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

/**
 * 将用户输入的自然语言路径、别名或相对路径解析为候选路径
 */
function resolvePathInput(inputPath, context = {}) {
    if (!inputPath || typeof inputPath !== 'string') return inputPath

    const raw = inputPath.trim()
    if (!raw) return raw

    const lastResolvedPath = getLastResolvedPath(context)

    // 支持「上次那个文件/刚才的目录」等指代
    if (lastResolvedPath && /(上次|刚才|之前|那个|这个|它)/.test(raw)) {
        return lastResolvedPath
    }

    // 支持常用语义别名，例如「日志」「插件目录」「配置文件」等
    const matchedAlias = COMMON_PATH_ALIASES.find(alias => alias.keywords.some(keyword => raw.includes(keyword)))
    if (matchedAlias) {
        const existingPath = matchedAlias.paths.find(p => fs.existsSync(p))
        if (existingPath) {
            return existingPath
        }
        if (matchedAlias.paths.length > 0) {
            return matchedAlias.paths[0]
        }
    }

    // 支持相对路径：优先相对上一次解析到的目录，其次相对当前工作目录
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

/**
 * 在白名单根目录下按文件名进行模糊查找
 * @param {string} inputPath - 用户输入的文件名或路径片段
 * @returns {string|null} 匹配到的绝对路径
 */
function findFuzzyPathInAllowedRoots(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return null

    const query = path.basename(inputPath.trim()).toLowerCase().replace(/(目录|文件)$/g, '')
    if (!query) return null

    const roots = Config.FILE_ROOTS
    if (!Array.isArray(roots) || roots.length === 0) return null

    // 仅排除依赖目录；.git 不再排除，允许查找/读取版本库内文件
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

/**
 * 检查文件路径是否在白名单内
 * @param {string} filePath - 绝对路径
 * @returns {object} { allowed: boolean, reason: string }
 */
function checkPathAllowed(filePath) {
    const roots = Config.FILE_ROOTS
    if (!roots || roots.length === 0) {
        return { allowed: false, reason: '未配置文件读取白名单(FILE_ROOTS)' }
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

/**
 * 判断文件是否为文本文件（非二进制）
 * 基于常见二进制扩展名 + 读取前 512 字节检测 null 字符
 */
function isTextFile(filePath) {
    const binaryExts = new Set([
        '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg',
        '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac', '.ogg',
        '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
        '.exe', '.dll', '.so', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.ttf', '.otf', '.woff', '.woff2', '.eot',
        '.pyc', '.class', '.o', '.a', '.lib',
    ])
    const ext = path.extname(filePath).toLowerCase()
    if (binaryExts.has(ext)) return false

    // 检测 null 字节（二进制特征）
    try {
        const buf = Buffer.alloc(512)
        const fd = fs.openSync(filePath, 'r')
        const bytesRead = fs.readSync(fd, buf, 0, 512, 0)
        fs.closeSync(fd)
        for (let i = 0; i < bytesRead; i++) {
            if (buf[i] === 0) return false
        }
    } catch {
        return false
    }
    return true
}

/**
 * 列出目录内容
 * @param {string} dirPath - 目录绝对路径
 * @param {object} options
 * @param {boolean} [options.readAll=false] - 是否读取所有文本文件内容
 * @param {number} [options.maxTotalSize=524288] - readAll 时全部文件总大小上限（默认 512KB）
 * @returns {string} 格式化的目录列表
 */
function readLocalDir(dirPath, options = {}) {
    const { readAll = false, maxTotalSize = Config.FILE_READ_ALL_MAX_TOTAL || 524288 } = options

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })

        // 分类排序：目录优先，然后按名称排序
        const dirs = []
        const files = []
        for (const entry of entries) {
            if (entry.isDirectory()) {
                dirs.push({ name: entry.name, type: 'dir', path: path.join(dirPath, entry.name) })
            } else if (entry.isFile()) {
                try {
                    const fileStat = fs.statSync(path.join(dirPath, entry.name))
                    files.push({ name: entry.name, type: 'file', path: path.join(dirPath, entry.name), size: fileStat.size })
                } catch {
                    files.push({ name: entry.name, type: 'file', path: path.join(dirPath, entry.name), size: 0 })
                }
            } else {
                files.push({ name: entry.name, type: 'other', path: path.join(dirPath, entry.name), size: 0 })
            }
        }

        dirs.sort((a, b) => a.name.localeCompare(b.name))
        files.sort((a, b) => a.name.localeCompare(b.name))

        const total = entries.length
        const dirCount = dirs.length
        const fileCount = files.length

        let output = `\n\n【目录「${path.basename(dirPath)}」(路径: ${dirPath}) 的内容：共 ${total} 项 (${dirCount} 个目录, ${fileCount} 个文件)】\n\n`

        if (dirs.length > 0) {
            output += `📁 目录:\n`
            for (const d of dirs) {
                output += `  [目录] ${d.name}/\n`
            }
            output += `\n`
        }

        if (files.length > 0) {
            output += `📄 文件:\n`
            for (const f of files) {
                const sizeKB = (f.size / 1024).toFixed(1)
                output += `  [文件] ${f.name}  (${sizeKB}KB)\n`
            }
        }

        output += `\n【目录内容结束】\n`

        // readAll：递归读取所有子目录的文本文件内容
        if (readAll) {
            let totalRead = 0
            let fileContents = ''
            let skippedBinary = 0
            let skippedSize = 0
            let skippedDir = 0

            const maxSingleSize = Config.FILE_MAX_SIZE || 4194304 // 单文件最大 4MB

            // 递归收集所有文件
            const allFiles = []
            function collectFiles(dir) {
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true })
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name)
                        if (entry.isDirectory()) {
                            // 跳过 node_modules（依赖目录）；.git 允许读取
                            if (entry.name === 'node_modules') {
                                skippedDir++
                                continue
                            }
                            collectFiles(fullPath)
                        } else if (entry.isFile()) {
                            try {
                                const stat = fs.statSync(fullPath)
                                allFiles.push({ path: fullPath, size: stat.size })
                            } catch { /* ignore */ }
                        }
                    }
                } catch { /* ignore */ }
            }
            collectFiles(dirPath)

            // 按路径排序
            allFiles.sort((a, b) => a.path.localeCompare(b.path))

            for (const f of allFiles) {
                if (f.size > maxSingleSize) {
                    skippedSize++
                    continue
                }
                if (!isTextFile(f.path)) {
                    skippedBinary++
                    continue
                }
                if (totalRead + f.size > maxTotalSize) {
                    output += `\n【文件内容读取】已达到总大小上限 (${(maxTotalSize / 1024).toFixed(0)}KB)，剩余文件未读取\n`
                    break
                }
                try {
                    const content = fs.readFileSync(f.path, 'utf-8')
                    const relPath = path.relative(dirPath, f.path)
                    const sizeKB = (f.size / 1024).toFixed(1)
                    fileContents += `\n--- 文件: ${relPath} (${sizeKB}KB) ---\n${content}\n`
                    totalRead += f.size
                } catch (err) {
                    fileContents += `\n--- 文件: ${path.relative(dirPath, f.path)} 读取失败: ${err.message} ---\n`
                }
            }

            if (fileContents) {
                const totalKB = (totalRead / 1024).toFixed(1)
                output += `\n【以下是该目录下所有文本文件的内容（共 ${totalKB}KB）：】\n${fileContents}\n【文件内容结束】\n`
            }

            if (skippedBinary > 0) output += `\n(已跳过 ${skippedBinary} 个二进制文件)\n`
            if (skippedSize > 0) output += `\n(已跳过 ${skippedSize} 个超大文件)\n`
            if (skippedDir > 0) output += `\n(已跳过 ${skippedDir} 个目录: node_modules)\n`

            logger.info(`[AI-Plugin] DirRead(readAll): ${dirPath} (递归, 读取 ${(totalRead / 1024).toFixed(1)}KB)`)
        } else {
            logger.info(`[AI-Plugin] DirRead: ${dirPath} (${total} 项)`)
        }

        return output
    } catch (err) {
        logger.warn(`[AI-Plugin] DirRead 读取失败: ${dirPath} - ${err.message}`)
        return `\n\n【目录读取失败】${err.message}\n`
    }
}

async function readLocalFile(filePath, options = {}, context = {}) {
    if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
        return '\n\n【文件读取失败】未指定文件路径。\n'
    }

    let realPath = path.resolve(resolvePathInput(filePath, context))

    if (!fs.existsSync(realPath)) {
        const fuzzyPath = findFuzzyPathInAllowedRoots(filePath)
        if (fuzzyPath) {
            realPath = path.resolve(fuzzyPath)
            logger.info(`[AI-Plugin] FileRead 模糊匹配: ${filePath} -> ${realPath}`)
        }
    }

    // 存在检查
    if (!fs.existsSync(realPath)) {
        return `\n\n【文件读取失败】文件不存在: ${realPath}\n`
    }

    // 安全检查
    const check = checkPathAllowed(realPath)
    if (!check.allowed) {
        const msg = `\n\n【文件读取被拒绝】${check.reason}\n`
        logger.warn(`[AI-Plugin] FileRead 拒绝: ${realPath} - ${check.reason}`)
        return msg
    }
    realPath = check.realPath

    // 类型检查：文件或目录
    const stat = fs.statSync(realPath)

    // 目录：列出内容
    if (stat.isDirectory()) {
        setLastResolvedPath(context, realPath)
        return readLocalDir(realPath, options)
    }

    if (!stat.isFile()) {
        return `\n\n【文件读取失败】路径既不是文件也不是目录: ${realPath}\n`
    }

    // 大小检查
    if (stat.size > Config.FILE_MAX_SIZE) {
        const sizeMB = (stat.size / 1048576).toFixed(2)
        return `\n\n【文件读取失败】文件过大 (${sizeMB}MB)，最大允许 ${Config.FILE_MAX_SIZE / 1048576}MB\n`
    }

    try {
        const content = fs.readFileSync(realPath, 'utf-8')
        setLastResolvedPath(context, realPath)
        const sizeKB = (stat.size / 1024).toFixed(1)
        logger.info(`[AI-Plugin] FileRead: ${realPath} (${sizeKB}KB)`)
        return `\n\n【以下是文件「${path.basename(realPath)}」(路径: ${realPath}, 大小: ${sizeKB}KB) 的内容：】\n\`\`\`\n${content}\n\`\`\`\n【文件内容结束】\n`
    } catch (err) {
        logger.warn(`[AI-Plugin] FileRead 读取失败: ${realPath} - ${err.message}`)
        return `\n\n【文件读取失败】${err.message}\n`
    }
}

export const fileReadTool = {
    name: 'file_read',
    permission: 'master',
    description: '读取本地文件或目录内容。仅限白名单目录，只读不写。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'file_read',
            description: '读取本地文件内容或列出目录（仅限白名单目录，只读）',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: '文件/目录路径，支持绝对路径、相对路径、常用别名（如 日志、配置、插件目录、模型配置）或文件名片段'
                    }
                },
                required: ['path']
            }
        }
    },

    async execute(args, context = {}) {
        const readAll = args.read_all === true
        const content = await readLocalFile(args.path, { readAll }, context)
        return content
    },

    formatResult(data) {
        return data
    }
}

export const dirReadTool = {
    name: 'dir_read',
    permission: 'master',
    description: '列出指定目录下的文件和子目录（仅限白名单目录，只读），支持读取目录下所有文本文件内容',

    functionSchema: {
        type: 'function',
        function: {
            name: 'dir_read',
            description: '列出指定目录下的文件和子目录列表（仅限白名单目录，只读）。支持 read_all 参数读取目录下所有文本文件内容。',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: '目录路径，支持绝对路径、相对路径、常用别名（如 日志、配置、插件目录、云崽data）或目录名片段'
                    },
                    read_all: {
                        type: 'boolean',
                        description: '是否读取该目录下所有文本文件的内容（默认 false）。开启后会自动跳过二进制文件和超大文件。'
                    }
                },
                required: ['path']
            }
        }
    },

    async execute(args, context = {}) {
        const readAll = args.read_all === true
        const content = await readLocalFile(args.path, { readAll }, context)
        return content
    },

    formatResult(data) {
        return data
    }
}

// 自动注册
toolRegistry.register(fileReadTool)
toolRegistry.register(dirReadTool)

// 导出白名单校验与模糊查找，供文件上传/下载工具复用，保持安全策略一致
export { checkPathAllowed, findFuzzyPathInAllowedRoots, resolvePathInput }