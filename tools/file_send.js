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
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

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

// docker 内 napcat 看不到宿主机路径时的典型错误特征
const DOCKER_NAPCAT_ERR_HINTS = [
    'no such file', 'not found', 'cannot find', 'enoent',
    'file not exist', 'file does not exist', '不存在', '找不到', '无法找到',
    'read file', '读取文件', 'failed to', 'upload', 'rich media transfer'
]

/** 判断 sendFile 报错是否疑似 docker napcat 路径不可见导致 */
function isLikelyDockerPathError(errMsg) {
    const lower = String(errMsg || '').toLowerCase()
    return DOCKER_NAPCAT_ERR_HINTS.some(k => lower.includes(k))
}

/** 生成 docker napcat 适配问题的排查提示 */
function buildDockerNapcatHint(sendPath) {
    const dirOfFile = path.dirname(sendPath)
    return [
        '',
        '⚠ 文件发送失败，疑似 NapCat 部署在 Docker 容器内、读取不到宿主机文件路径导致。',
        `本次尝试发送的服务器路径为：${sendPath}`,
        '',
        '━━━━━━━━━━ 原因说明 ━━━━━━━━━━',
        '发送文件时，本插件只是把"宿主机上的本地路径"字符串交给 NapCat，',
        '真正去打开并上传这个文件的是 NapCat 自己（OneBot 的 upload_group_file / upload_private_file 接口）。',
        '如果 NapCat 跑在 Docker 容器里，容器内部是一套独立的文件系统，',
        '宿主机的这个路径在容器里根本不存在，于是 NapCat 报"文件找不到/读取失败"。',
        'TRSS-Yunzai 与插件本身能读到该文件，不代表容器里的 NapCat 也能读到——这是两个不同的文件系统视角。',
        '',
        '━━━━━━━━━━ 如何确认是不是这个问题 ━━━━━━━━━━',
        '1. 确认 NapCat 是用 Docker 跑的（docker ps 能看到 napcat 容器）。',
        '2. 进入容器检查这个路径在容器里是否存在：',
        `   docker exec -it <napcat容器名> ls -l "${sendPath}"`,
        '   若提示 No such file or directory，即可确认是路径不可见问题。',
        '',
        '━━━━━━━━━━ 解决方案（按推荐顺序） ━━━━━━━━━━',
        '【方案一｜推荐】把文件所在目录挂载进容器，并让"容器内外路径完全一致"',
        '  这样插件传给 NapCat 的宿主机路径，在容器里指向的就是同一个文件，零改动即可生效。',
        '  · docker run 写法：在原有命令上追加一行卷挂载',
        `      -v "${dirOfFile}:${dirOfFile}"`,
        '  · docker-compose 写法：在该服务的 volumes 下加一行',
        '      volumes:',
        `        - "${dirOfFile}:${dirOfFile}"`,
        '  · 建议直接把 file_roots.yaml 里的白名单根目录整体挂载进去，省得每个子目录单独挂。',
        '  · 改完后需要重新创建容器使挂载生效：',
        '      docker compose up -d   （或 docker rm -f 后用新的 -v 重新 docker run）',
        '',
        '【方案二】把要发送的文件放到"已经和容器共享的目录"里再发',
        '  NapCat 容器通常已经挂了数据目录（如宿主机某目录映射到容器内 /app/.config/QQ 之类），',
        '  把目标文件复制到这个已共享目录下，再把该宿主机目录加入 file_roots.yaml 白名单，然后发送。',
        '  注意：若容器内外路径不一致，仍可能失败，优先用方案一保持路径一致。',
        '',
        '【方案三】检查 NapCat 自身的文件/富媒体上传权限与配置',
        '  确认 NapCat 的 OneBot 配置已允许文件上传，且账号有发文件权限（如群文件需要管理权限或群设置允许）。',
        '',
        '━━━━━━━━━━ 补充 ━━━━━━━━━━',
        '· 若 NapCat 与 TRSS-Yunzai 都在同一宿主机原生运行（没用 Docker），通常不会有此问题，',
        '  请改为检查：文件是否真实存在、是否有读取权限、文件是否过大或为空。',
        '· 若 NapCat 和 Yunzai 分别在不同机器/不同容器，本质同理，需保证 NapCat 那侧能访问到该文件路径。'
    ].join('\n')
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
                    },
                    as_image: {
                        type: 'boolean',
                        description: '可选。仅当用户明确要求“以图片形式/作为图片/直接发图”发送图片文件时设为 true；否则保持 false，按普通文件发送。'
                    }
                },
                required: ['path']
            }
        }
    },

    async execute(args = {}, context = {}) {
        const rawInput = String(args.path || '').trim()
        const asImage = args.as_image === true || args.as_image === 'true'
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

        if (asImage) {
            if (!stats.isFile()) {
                return `【文件发送失败】目标不是图片文件，无法以图片形式发送: ${realPath}`
            }
            const ext = path.extname(realPath).toLowerCase()
            if (!IMAGE_EXTS.has(ext)) {
                return `【文件发送失败】目标不是支持的图片格式（支持 png/jpg/jpeg/webp/gif）: ${path.basename(realPath)}`
            }
            if (stats.size > MAX_SEND_SIZE) {
                return `【文件发送失败】图片过大（${(stats.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_SEND_SIZE / 1024 / 1024}MB 上限，QQ 可能无法发送。`
            }
            if (stats.size === 0) {
                return `【文件发送失败】图片文件为空: ${path.basename(realPath)}`
            }
            const imageBase64 = fs.readFileSync(realPath).toString('base64')
            await event.reply(segment.image(`base64://${imageBase64}`), true)
            return {
                ok: true,
                fileName: path.basename(realPath),
                sourcePath: realPath,
                sizeBytes: stats.size,
                isArchive: false,
                asImage: true
            }
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
            // sendFile 抛错且特征疑似 docker napcat 路径不可见 → 附带排查与解决方案
            if (isLikelyDockerPathError(err.message)) {
                return `【文件发送失败】${err.message}\n${buildDockerNapcatHint(sendPath)}`
            }
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
        if (data.asImage) {
            return `\n\n【图片发送成功】已将图片发送到当前会话。\n名称: ${data.fileName}\n来源: ${data.sourcePath}\n大小: ${sizeMb}MB\n`
        }
        const kind = data.isArchive ? '文件夹（已打包为 tar.gz）' : '文件'
        return `\n\n【文件发送成功】已将${kind}发送到当前会话。\n名称: ${data.fileName}\n来源: ${data.sourcePath}\n大小: ${sizeMb}MB\n`
    }
}

// 自动注册
toolRegistry.register(fileSendTool)
