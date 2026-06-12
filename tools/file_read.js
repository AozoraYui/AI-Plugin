/**
 * 本地文件只读工具
 * 允许 AI 读取用户指定的文件（仅限白名单目录）
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

    // 类型检查（只读文件，拒绝目录）
    const stat = fs.statSync(realPath)
    if (!stat.isFile()) {
        return `\n\n【文件读取失败】路径不是文件: ${realPath}\n`
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
    description: '读取本地文件内容。仅限白名单目录，只读不写。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'file_read',
            description: '读取本地文件内容（仅限白名单目录，只读）',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: '文件的绝对路径'
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