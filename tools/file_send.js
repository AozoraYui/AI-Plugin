/**
 * 本地文件上传工具
 * 允许 AI 把白名单目录下的文件/文件夹发送到当前会话（群/好友）。
 * 仅主人可用；路径受 file_roots.yaml 白名单约束，与文件读取保持一致的安全策略。
 * 文件夹会先用系统 tar 打包为 .tar.gz 再发送，避免引入额外依赖。
 */

import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolRegistry } from './registry.js'
import { checkPathAllowed, findFuzzyPathInAllowedRoots, resolvePathInput } from './file_read.js'

// 单个文件发送上限（字节）。过大文件 QQ 通常发送失败，提前拦截给出清晰提示。
const MAX_SEND_SIZE = 200 * 1024 * 1024 // 200MB

/** 将文件夹打包为临时 tar.gz，返回压缩包路径 */
function packDirectory(dirPath) {
    return new Promise((resolve, reject) => {
        const dirName = path.basename(dirPath.replace(/[/\\]+$/, '')) || 'archive'
        const tmpFile = path.join(os.tmpdir(), `ai-plugin-send-${Date.now()}-${dirName}.tar.gz`)
        // -C 父目录，仅打包目标目录本身，避免把绝对路径写进包里
        const parent = path.dirname(dirPath)
        const base = path.basename(dirPath)
        const cmd = `tar -czf ${JSON.stringify(tmpFile)} -C ${JSON.stringify(parent)} ${JSON.stringify(base)}`
        exec(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err) => {
            if (err) {
                reject(new Error(`打包文件夹失败: ${err.message}`))
                return
            }
            resolve(tmpFile)
        })
    })
}

/** 通过 QQ 事件对象把文件发送到当前会话 */
async function sendFileToSession(event, filePath, fileName) {
    if (!event) throw new Error('缺少会话上下文，无法发送文件')
    if (event.isGroup && event.group?.sendFile) {
        await event.group.sendFile(filePath, fileName)
    } else if (event.friend?.sendFile) {
        await event.friend.sendFile(filePath, fileName)
    } else if (event.bot?.sendFile) {
        await event.bot.sendFile(filePath, fileName)
    } else {
        throw new Error('当前适配器不支持发送文件')
    }
}

export const fileSendTool = {
    name: 'file_send',
    permission: 'master',
    description: '把服务器白名单目录下的文件或文件夹发送到当前 QQ 会话（群或好友）。仅限主人。适合主人说"把某个文件发我""发一下那个日志/配置/脚本"等场景。文件夹会自动打包为 tar.gz 后发送。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'file_send',
            description: '将服务器本地文件/文件夹发送到当前会话。仅限主人，路径受白名单约束。',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: '要发送的文件或文件夹路径，支持绝对路径、相对路径、常用别名或文件名片段（会在白名单目录内模糊查找）。建议先用 dir_read/file_read 确认目标文件后再发送。'
                    }
                },
                required: ['path']
            }
        }
    },

    async execute(args = {}, context = {}) {
        const rawInput = String(args.path || '').trim()
        if (!rawInput) return '【文件发送失败】未提供 path。'

        const event = context.event
        if (!event) return '【文件发送失败】缺少会话上下文，无法发送文件。'

        // 解析路径：先走别名/相对路径解析，命中不到再在白名单目录内模糊查找
        let resolved = resolvePathInput(rawInput, context)
        if (!resolved || !fs.existsSync(resolved)) {
            const fuzzy = findFuzzyPathInAllowedRoots(rawInput)
            if (fuzzy) resolved = fuzzy
        }
        if (!resolved || !fs.existsSync(resolved)) {
            return `【文件发送失败】未找到文件: ${rawInput}（请确认文件名或先用目录浏览确认路径）`
        }

        // 白名单校验：与文件读取一致，只能发送白名单目录内的文件
        const check = checkPathAllowed(resolved)
        if (!check.allowed) {
            return `【文件发送失败】${check.reason}`
        }
        const realPath = check.realPath

        let stats
        try {
            stats = fs.statSync(realPath)
        } catch (err) {
            return `【文件发送失败】无法读取文件信息: ${err.message}`
        }

        let sendPath = realPath
        let fileName = path.basename(realPath)
        let tempToClean = null
        let isArchive = false

        try {
            if (stats.isDirectory()) {
                sendPath = await packDirectory(realPath)
                fileName = `${path.basename(realPath.replace(/[/\\]+$/, '')) || 'archive'}.tar.gz`
                tempToClean = sendPath
                isArchive = true
            } else if (!stats.isFile()) {
                return `【文件发送失败】目标既不是文件也不是文件夹: ${realPath}`
            }

            const sendStats = fs.statSync(sendPath)
            if (sendStats.size > MAX_SEND_SIZE) {
                return `【文件发送失败】文件过大（${(sendStats.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_SEND_SIZE / 1024 / 1024}MB 上限，QQ 可能无法发送。`
            }
            if (sendStats.size === 0) {
                return `【文件发送失败】文件为空: ${fileName}`
            }

            await sendFileToSession(event, sendPath, fileName)

            return {
                ok: true,
                fileName,
                sourcePath: realPath,
                sizeBytes: sendStats.size,
                isArchive
            }
        } catch (err) {
            return `【文件发送失败】${err.message}`
        } finally {
            if (tempToClean && fs.existsSync(tempToClean)) {
                try { fs.unlinkSync(tempToClean) } catch { /* ignore */ }
            }
        }
    },

    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data || !data.ok) return String(data || '')
        const sizeMb = (data.sizeBytes / 1024 / 1024).toFixed(2)
        const kind = data.isArchive ? '文件夹（已打包为 tar.gz）' : '文件'
        return `\n\n【文件发送成功】已将${kind}发送到当前会话。\n名称: ${data.fileName}\n来源: ${data.sourcePath}\n大小: ${sizeMb}MB\n`
    }
}

// 自动注册
toolRegistry.register(fileSendTool)
