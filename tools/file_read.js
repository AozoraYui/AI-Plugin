/**
 * 本地文件只读 & 目录浏览工具
 * 允许 AI 读取白名单目录下的文件和目录列表（只读）
 */

import { toolRegistry } from './registry.js'
import fs from 'node:fs'
import path from 'node:path'
import { Config } from '../utils/config.js'

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

    const realPath = path.resolve(filePath)

    for (const root of roots) {
        const realRoot = path.resolve(root)
        if (realPath === realRoot || realPath.startsWith(realRoot + path.sep)) {
            return { allowed: true }
        }
    }

    return { allowed: false, reason: `路径不在白名单内: ${realPath}` }
}

/**
 * 列出目录内容
 * @param {string} dirPath - 目录绝对路径
 * @returns {string} 格式化的目录列表
 */
function readLocalDir(dirPath) {
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
        logger.info(`[AI-Plugin] DirRead: ${dirPath} (${total} 项)`)
        return output
    } catch (err) {
        logger.warn(`[AI-Plugin] DirRead 读取失败: ${dirPath} - ${err.message}`)
        return `\n\n【目录读取失败】${err.message}\n`
    }
}

async function readLocalFile(filePath) {
    if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
        return '\n\n【文件读取失败】未指定文件路径。\n'
    }

    const realPath = path.resolve(filePath.trim())

    // 安全检查
    const check = checkPathAllowed(realPath)
    if (!check.allowed) {
        const msg = `\n\n【文件读取被拒绝】${check.reason}\n`
        logger.warn(`[AI-Plugin] FileRead 拒绝: ${realPath} - ${check.reason}`)
        return msg
    }

    // 存在检查
    if (!fs.existsSync(realPath)) {
        return `\n\n【文件读取失败】文件不存在: ${realPath}\n`
    }

    // 类型检查：文件或目录
    const stat = fs.statSync(realPath)

    // 目录：列出内容
    if (stat.isDirectory()) {
        return readLocalDir(realPath)
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
                        description: '文件或目录的绝对路径'
                    }
                },
                required: ['path']
            }
        }
    },

    async execute(args) {
        const content = await readLocalFile(args.path)
        return content
    },

    formatResult(data) {
        return data
    }
}

export const dirReadTool = {
    name: 'dir_read',
    description: '列出指定目录下的文件和子目录（仅限白名单目录，只读）',

    functionSchema: {
        type: 'function',
        function: {
            name: 'dir_read',
            description: '列出指定目录下的文件和子目录列表（仅限白名单目录，只读）',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: '目录的绝对路径'
                    }
                },
                required: ['path']
            }
        }
    },

    async execute(args) {
        const content = await readLocalFile(args.path)
        return content
    },

    formatResult(data) {
        return data
    }
}

// 自动注册
toolRegistry.register(fileReadTool)
toolRegistry.register(dirReadTool)