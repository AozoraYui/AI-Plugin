/**
 * 文件下载工具
 * 把当前消息 / 引用消息中的图片、视频、语音、文件下载到服务器白名单目录。
 * 仅主人可用；保存目录受 file_roots.yaml 白名单约束，与文件读取保持一致的安全策略。
 */

import fs from 'node:fs'
import path from 'node:path'
import { toolRegistry } from './registry.js'
import { checkPathAllowed } from './file_read.js'
import { Config } from '../utils/config.js'

const MAX_FORWARD_DEPTH = 3
const DL_MAX_RETRIES = 3
const DL_TIMEOUT_MS = 30000
const DL_RETRY_DELAYS = [1000, 2000, 4000]

// content-type → 后缀映射（兜底用，优先使用消息段自带文件名）
const CONTENT_TYPE_EXT = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/bmp': '.bmp',
    'video/mp4': '.mp4', 'video/quicktime': '.mov',
    'audio/amr': '.amr', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/silk': '.silk',
    'application/zip': '.zip', 'application/x-7z-compressed': '.7z',
    'application/x-rar-compressed': '.rar', 'application/pdf': '.pdf'
}

// 从单个消息段提取可下载媒体 { url, type, name }
function extractMediaFromSeg(seg) {
    const items = []
    const type = seg.type
    if (type === 'image') {
        const url = seg.data?.url || seg.url
        if (url) items.push({ url, type: 'image', name: seg.data?.file || seg.file })
    } else if (type === 'video') {
        const url = seg.data?.url || seg.url
        if (url) items.push({ url, type: 'video', name: seg.data?.file || seg.file })
    } else if (type === 'record' || type === 'audio') {
        const url = seg.data?.url || seg.url
        if (url) items.push({ url, type: 'audio', name: seg.data?.file || seg.file })
    } else if (type === 'file') {
        const url = seg.data?.url || seg.url
        const name = seg.data?.name || seg.data?.file || seg.name || seg.file
        if (url) items.push({ url, type: 'file', name })
    }
    return items
}

// 递归收集消息段数组中的所有可下载媒体（含嵌套合并转发）
async function collectMediaFromMsgArray(bot, msgArray, depth = 0) {
    const media = []
    if (!Array.isArray(msgArray) || depth >= MAX_FORWARD_DEPTH) return media
    for (const seg of msgArray) {
        if (!seg || typeof seg !== 'object') continue
        if (seg.type === 'forward') {
            const nestedContent = seg.content || seg.data?.content
            if (Array.isArray(nestedContent)) {
                for (const nestedMsg of nestedContent) {
                    const arr = nestedMsg.content || nestedMsg.message
                    media.push(...await collectMediaFromMsgArray(bot, arr, depth + 1))
                }
            } else {
                const nestedId = seg.id || seg.data?.id
                if (nestedId && bot?.sendApi) {
                    try {
                        const res = await bot.sendApi('get_forward_msg', { message_id: nestedId })
                        const details = res?.messages || res?.data?.messages || res
                        if (Array.isArray(details)) {
                            for (const sub of details) {
                                const arr = sub.content || sub.message
                                media.push(...await collectMediaFromMsgArray(bot, arr, depth + 1))
                            }
                        }
                    } catch (err) {
                        logger.warn(`[AI-Plugin] 文件下载：展开嵌套转发失败: ${err.message}`)
                    }
                }
            }
        } else {
            media.push(...extractMediaFromSeg(seg))
        }
    }
    return media
}

// 从事件对象收集待下载媒体：优先引用消息，其次当前消息
async function collectMediaFromEvent(event) {
    const media = []
    // 1. 引用消息（回复）
    const replySeg = (event.message || []).find?.(s => s.type === 'reply')
    const replyId = replySeg?.data?.id || replySeg?.id || event.source?.message_id || event.reply_id
    if (replyId) {
        try {
            let srcMsgs
            if (event.group?.getForwardMsg) {
                try { srcMsgs = await event.group.getForwardMsg(replyId) } catch { /* not a forward */ }
            }
            if (!srcMsgs && event.group?.getMsg) {
                const m = await event.group.getMsg(replyId)
                if (m) srcMsgs = [m]
            }
            if (!srcMsgs && event.bot?.getMsg) {
                const m = await event.bot.getMsg(replyId)
                if (m) srcMsgs = [m]
            }
            if (Array.isArray(srcMsgs)) {
                for (const m of srcMsgs) {
                    const arr = m.message || m.content
                    media.push(...await collectMediaFromMsgArray(event.bot, arr, 0))
                }
            }
        } catch (err) {
            logger.warn(`[AI-Plugin] 文件下载：获取引用消息失败: ${err.message}`)
        }
    }
    // 2. 当前消息本身
    if (Array.isArray(event.message)) {
        media.push(...await collectMediaFromMsgArray(event.bot, event.message, 0))
    }
    // 去重（按 url）
    const seen = new Set()
    return media.filter(m => {
        if (!m.url || seen.has(m.url)) return false
        seen.add(m.url)
        return true
    })
}

// 解析保存目录：默认白名单第一个根目录下的 ai-download，可由参数指定（仍受白名单约束）
// noTimestamp=true 时直接使用指定目录，不再追加时间戳子目录
function resolveSaveDir(inputDir, noTimestamp = false) {
    const roots = Config.FILE_ROOTS
    if (!Array.isArray(roots) || roots.length === 0) {
        return { error: '未配置文件白名单(FILE_ROOTS)，无法确定保存目录' }
    }

    let baseDir
    if (inputDir && String(inputDir).trim()) {
        baseDir = path.resolve(String(inputDir).trim())
    } else {
        baseDir = path.join(path.resolve(roots[0]), 'ai-download')
    }

    let target
    if (noTimestamp) {
        // 直接使用目标目录本身，不建时间戳子目录
        target = baseDir
    } else {
        // 生成时间戳子目录，避免覆盖
        const now = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
        target = path.join(baseDir, ts)
        let suffix = 0
        while (fs.existsSync(target)) {
            suffix++
            target = path.join(baseDir, `${ts}_${suffix}`)
        }
    }

    // 先建目录再校验白名单（checkPathAllowed 需要真实路径）
    try {
        fs.mkdirSync(target, { recursive: true })
    } catch (err) {
        return { error: `创建保存目录失败: ${err.message}` }
    }
    const check = checkPathAllowed(target)
    if (!check.allowed) {
        if (!noTimestamp) { try { fs.rmdirSync(target) } catch { /* ignore */ } }
        return { error: `保存目录不在白名单内: ${check.reason || target}` }
    }
    return { dir: check.realPath }
}

// 下载单个媒体（带重试 + 超时）
// renameSequential=true 时统一命名为 序号.后缀（如 0.png），index 从 0 起
async function downloadOne(item, index, targetDir, renameSequential = false) {
    for (let attempt = 1; attempt <= DL_MAX_RETRIES; attempt++) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), DL_TIMEOUT_MS)
        try {
            const res = await fetch(item.url, { signal: controller.signal })
            clearTimeout(timer)
            if (!res.ok) {
                logger.warn(`[AI-Plugin] 文件下载失败 HTTP ${res.status}: ${item.url}`)
                return { ok: false }
            }
            // 推断后缀：优先消息段自带名的扩展名，其次按 content-type
            const ct = (res.headers.get('content-type') || '').split(';')[0].trim()
            const nameExt = item.name && /\.([a-z0-9]{1,8})$/i.test(item.name) ? item.name.match(/\.[a-z0-9]{1,8}$/i)[0] : ''
            const ext = nameExt || CONTENT_TYPE_EXT[ct] || (item.type === 'image' ? '.png' : '.bin')

            let fileName
            if (renameSequential) {
                // 统一按序号重命名：0.png、1.png ...
                fileName = `${index}${ext}`
            } else {
                // 优先消息段自带名，其次按类型+序号
                fileName = item.name && /\.[a-z0-9]{1,8}$/i.test(item.name) ? item.name : `${item.type}_${index}${ext}`
            }
            // 防目录穿越，只保留 basename
            fileName = path.basename(fileName)
            const buf = Buffer.from(await res.arrayBuffer())
            const filePath = path.join(targetDir, fileName)
            fs.writeFileSync(filePath, buf)
            return { ok: true, fileName, size: buf.length, type: item.type }
        } catch (err) {
            clearTimeout(timer)
            if (attempt < DL_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, DL_RETRY_DELAYS[attempt - 1]))
            } else {
                logger.warn(`[AI-Plugin] 文件下载失败（已重试${DL_MAX_RETRIES}次）: ${err.message} - ${item.url}`)
                return { ok: false }
            }
        }
    }
    return { ok: false }
}

export const fileDownloadTool = {
    name: 'file_download',
    permission: 'master',
    description: '把当前消息或引用消息中的图片、视频、语音、文件下载并保存到服务器白名单目录。仅限主人。适合主人说"把这个文件存到服务器""下载我引用的图片/视频"等场景。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'file_download',
            description: '下载消息/引用消息中的媒体到服务器白名单目录。仅限主人。',
            parameters: {
                type: 'object',
                properties: {
                    save_dir: {
                        type: 'string',
                        description: '可选，保存目录（必须在白名单内）。不填则默认保存到白名单首个目录下的 ai-download/时间戳 子目录。'
                    },
                    no_timestamp: {
                        type: 'boolean',
                        description: '可选。为 true 时直接把文件存到 save_dir 本身，不再创建时间戳子目录。用户说"不要时间戳目录/直接存到这个目录/就放在xxx下"时设为 true。'
                    },
                    rename_sequential: {
                        type: 'boolean',
                        description: '可选。为 true 时把下载的文件统一重命名为 0.png、1.png、2.png… 这种按顺序的序号文件名（后缀按原文件类型）。用户要求"重命名为0 1 2/按顺序命名/命名成0.png这种"时设为 true。'
                    }
                },
                required: []
            }
        }
    },

    async execute(args = {}, context = {}) {
        const event = context.event
        if (!event) return '【文件下载失败】缺少会话上下文，无法读取消息。'

        const media = await collectMediaFromEvent(event)
        if (media.length === 0) {
            return '【文件下载失败】当前消息和引用消息中都没有找到可下载的图片/视频/语音/文件。请引用包含媒体的消息后再试。'
        }

        const dirResult = resolveSaveDir(args.save_dir, args.no_timestamp === true || args.no_timestamp === 'true')
        if (dirResult.error) return `【文件下载失败】${dirResult.error}`
        const targetDir = dirResult.dir

        const renameSequential = args.rename_sequential === true || args.rename_sequential === 'true'
        const results = []
        let index = 0
        for (const item of media) {
            const r = await downloadOne(item, index, targetDir, renameSequential)
            if (r.ok) {
                results.push(r)
                index++
            }
        }

        if (results.length === 0) {
            // 仅在自建的时间戳子目录为空时清理；用户指定的目录(no_timestamp)不删
            if (args.no_timestamp !== true && args.no_timestamp !== 'true') {
                try { fs.rmdirSync(targetDir) } catch { /* ignore */ }
            }
            return `【文件下载失败】共发现 ${media.length} 个媒体，但全部下载失败，详情见日志。`
        }

        return {
            ok: true,
            dir: targetDir,
            total: media.length,
            saved: results.length,
            files: results.map(r => ({ name: r.fileName, type: r.type, size: r.size }))
        }
    },

    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data || !data.ok) return String(data || '')
        let out = `\n\n【文件下载成功】已保存 ${data.saved}/${data.total} 个文件到：\n${data.dir}\n`
        for (const f of data.files) {
            out += `- ${f.name}（${f.type}, ${(f.size / 1024).toFixed(1)}KB）\n`
        }
        return out
    }
}

// 自动注册
toolRegistry.register(fileDownloadTool)

