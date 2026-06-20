/**
 * 群文件工具
 * 让 AI 浏览当前群的群文件（文件/文件夹列表），并把指定群文件下载到服务器白名单目录。
 * 仅主人可用；下载保存目录受 file_roots.yaml 白名单约束，与文件读取保持一致的安全策略。
 * 依赖 NapCat / go-cqhttp 兼容的 OneBot 接口：
 *   get_group_root_files / get_group_files_by_folder / get_group_file_url
 */

import fs from 'node:fs'
import path from 'node:path'
import { toolRegistry } from './registry.js'
import { checkPathAllowed } from './file_read.js'
import { Config } from '../utils/config.js'

const GF_MAX_DEPTH = 3          // 递归遍历群文件夹的最大深度
const GF_DL_MAX_RETRIES = 3     // 下载重试次数
const GF_DL_TIMEOUT_MS = 60000  // 单文件下载超时
const GF_DL_RETRY_DELAYS = [1000, 2000, 4000]

// 统一从 OneBot 返回结构里取 data（NapCat 可能是 res 或 res.data）
function unwrap(res) {
    if (res && typeof res === 'object' && 'data' in res && res.data && typeof res.data === 'object') {
        return res.data
    }
    return res
}

// 调用 bot API，兼容 event.bot.sendApi
async function callApi(event, action, params) {
    const bot = event.bot
    if (!bot?.sendApi) throw new Error('当前适配器不支持 sendApi，无法访问群文件')
    const res = await bot.sendApi(action, params)
    return unwrap(res)
}

// 规范化单个文件对象
function normFile(f) {
    return {
        kind: 'file',
        fileId: f.file_id || f.id,
        name: f.file_name || f.name || '未命名文件',
        size: Number(f.file_size || f.size || 0),
        busid: f.busid ?? f.bus_id ?? 0,
        uploader: f.uploader_name || f.uploader || ''
    }
}

// 规范化单个文件夹对象
function normFolder(d) {
    return {
        kind: 'folder',
        folderId: d.folder_id || d.id,
        name: d.folder_name || d.name || '未命名文件夹',
        fileCount: Number(d.total_file_count || d.file_count || 0)
    }
}

// 拉取某层（root 或指定 folder）的文件与文件夹
async function listLayer(event, folderId) {
    const params = { group_id: event.group_id }
    let data
    if (folderId) {
        params.folder_id = folderId
        data = await callApi(event, 'get_group_files_by_folder', params)
    } else {
        data = await callApi(event, 'get_group_root_files', params)
    }
    const rawFiles = data?.files || []
    const rawFolders = data?.folders || []
    return {
        files: rawFiles.map(normFile),
        folders: rawFolders.map(normFolder)
    }
}

// 递归收集全部文件（含子文件夹），用于按名查找
async function collectAllFiles(event, folderId, depth, acc) {
    if (depth > GF_MAX_DEPTH) return
    const { files, folders } = await listLayer(event, folderId)
    for (const f of files) acc.push(f)
    for (const d of folders) {
        try {
            await collectAllFiles(event, d.folderId, depth + 1, acc)
        } catch (err) {
            logger.warn(`[AI-Plugin] 群文件：遍历子文件夹 ${d.name} 失败: ${err.message}`)
        }
    }
}

// 解析下载保存目录（受白名单约束），不带时间戳子目录，直接存入目标目录
function resolveSaveDir(inputDir) {
    const roots = Config.FILE_ROOTS
    if (!Array.isArray(roots) || roots.length === 0) {
        return { error: '未配置文件白名单(FILE_ROOTS)，无法确定保存目录' }
    }
    let baseDir
    if (inputDir && String(inputDir).trim()) {
        baseDir = path.resolve(String(inputDir).trim())
    } else {
        baseDir = path.join(path.resolve(roots[0]), 'group-download')
    }
    try {
        fs.mkdirSync(baseDir, { recursive: true })
    } catch (err) {
        return { error: `创建保存目录失败: ${err.message}` }
    }
    const check = checkPathAllowed(baseDir)
    if (!check.allowed) {
        return { error: `保存目录不在白名单内: ${check.reason || baseDir}` }
    }
    return { dir: check.realPath }
}

// 下载单个 URL 到目标目录，返回保存结果
async function downloadUrl(url, targetDir, fileName) {
    // 防目录穿越
    let safeName = path.basename(String(fileName || 'group_file'))
    let filePath = path.join(targetDir, safeName)
    // 文件名冲突则加序号
    if (fs.existsSync(filePath)) {
        const ext = path.extname(safeName)
        const base = path.basename(safeName, ext)
        let i = 1
        while (fs.existsSync(path.join(targetDir, `${base}_${i}${ext}`))) i++
        safeName = `${base}_${i}${ext}`
        filePath = path.join(targetDir, safeName)
    }
    for (let attempt = 1; attempt <= GF_DL_MAX_RETRIES; attempt++) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), GF_DL_TIMEOUT_MS)
        try {
            const res = await fetch(url, { signal: controller.signal })
            clearTimeout(timer)
            if (!res.ok) {
                if (attempt < GF_DL_MAX_RETRIES) { await new Promise(r => setTimeout(r, GF_DL_RETRY_DELAYS[attempt - 1])); continue }
                return { ok: false, reason: `HTTP ${res.status}` }
            }
            const buf = Buffer.from(await res.arrayBuffer())
            fs.writeFileSync(filePath, buf)
            return { ok: true, fileName: safeName, filePath, size: buf.length }
        } catch (err) {
            clearTimeout(timer)
            if (attempt < GF_DL_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, GF_DL_RETRY_DELAYS[attempt - 1]))
            } else {
                return { ok: false, reason: err.message }
            }
        }
    }
    return { ok: false, reason: '未知错误' }
}

// 获取群文件下载直链（兼容不同字段名）
async function getFileUrl(event, fileId, busid) {
    const params = { group_id: event.group_id, file_id: fileId }
    if (busid !== undefined && busid !== null) params.busid = busid
    const data = await callApi(event, 'get_group_file_url', params)
    return data?.url || data?.file_url || data
}

export const groupFileListTool = {
    name: 'group_file_list',
    permission: 'master',
    description: '浏览当前 QQ 群的群文件，列出群文件区里有哪些文件和文件夹。仅限主人。适合主人说"看看群文件都有哪些东西""群文件里有什么""列一下群文件"等场景。只能在群聊中使用。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'group_file_list',
            description: '列出当前群文件区的文件与文件夹。仅限主人，仅群聊可用。',
            parameters: {
                type: 'object',
                properties: {
                    folder_name: {
                        type: 'string',
                        description: '可选，要进入查看的子文件夹名称。不填则列出群文件根目录。'
                    }
                },
                required: []
            }
        }
    },

    async execute(args = {}, context = {}) {
        const event = context.event
        if (!event) return '【群文件浏览失败】缺少会话上下文。'
        if (!event.group_id) return '【群文件浏览失败】该功能仅在群聊中可用。'

        try {
            // 指定了子文件夹名 → 先在根目录找到对应 folderId
            let targetFolderId = null
            let layerName = '根目录'
            if (args.folder_name && String(args.folder_name).trim()) {
                const q = String(args.folder_name).trim().toLowerCase()
                const root = await listLayer(event, null)
                const hit = root.folders.find(d => d.name.toLowerCase() === q)
                    || root.folders.find(d => d.name.toLowerCase().includes(q))
                if (!hit) {
                    return `【群文件浏览失败】根目录下未找到名为「${args.folder_name}」的文件夹。`
                }
                targetFolderId = hit.folderId
                layerName = hit.name
            }

            const { files, folders } = await listLayer(event, targetFolderId)
            return {
                ok: true,
                layerName,
                folders: folders.map(d => ({ name: d.name, fileCount: d.fileCount })),
                files: files.map(f => ({ name: f.name, size: f.size, uploader: f.uploader }))
            }
        } catch (err) {
            logger.error('[AI-Plugin] 群文件浏览异常:', err)
            return `【群文件浏览失败】${err.message}`
        }
    },

    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data || !data.ok) return String(data || '')
        let out = `\n\n【群文件列表 - ${data.layerName}】\n`
        if (data.folders.length === 0 && data.files.length === 0) {
            out += '（该位置为空）\n'
            return out
        }
        if (data.folders.length > 0) {
            out += '文件夹：\n'
            for (const d of data.folders) out += `  📁 ${d.name}（${d.fileCount} 个文件）\n`
        }
        if (data.files.length > 0) {
            out += '文件：\n'
            for (const f of data.files) {
                const mb = f.size > 0 ? `${(f.size / 1024 / 1024).toFixed(2)}MB` : '未知大小'
                out += `  📄 ${f.name}（${mb}${f.uploader ? `，上传者 ${f.uploader}` : ''}）\n`
            }
        }
        out += '\n请把以上群文件内容如实告知主人。若主人要下载某个文件，可使用 group_file_download 工具。'
        return out
    }
}

export const groupFileDownloadTool = {
    name: 'group_file_download',
    permission: 'master',
    description: '把当前 QQ 群群文件区里的指定文件下载并保存到服务器白名单目录。仅限主人。适合主人说"把群文件里的xxx下载到xxx目录""把那个文件存到服务器"等场景。只能在群聊中使用。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'group_file_download',
            description: '按文件名把群文件下载到服务器白名单目录。仅限主人，仅群聊可用。',
            parameters: {
                type: 'object',
                properties: {
                    file_name: {
                        type: 'string',
                        description: '要下载的群文件名称，支持完整文件名或名称片段（会在群文件中模糊匹配）。'
                    },
                    save_dir: {
                        type: 'string',
                        description: '可选，保存目录（必须在白名单内）。不填则默认保存到白名单首个目录下的 group-download 子目录。'
                    }
                },
                required: ['file_name']
            }
        }
    },

    async execute(args = {}, context = {}) {
        const event = context.event
        if (!event) return '【群文件下载失败】缺少会话上下文。'
        if (!event.group_id) return '【群文件下载失败】该功能仅在群聊中可用。'

        const query = String(args.file_name || '').trim()
        if (!query) return '【群文件下载失败】未提供要下载的文件名。'

        try {
            // 递归收集全部群文件后按名匹配
            const all = []
            await collectAllFiles(event, null, 0, all)
            if (all.length === 0) return '【群文件下载失败】当前群文件区为空，没有可下载的文件。'

            const qLower = query.toLowerCase()
            let matched = all.filter(f => f.name.toLowerCase() === qLower)
            if (matched.length === 0) matched = all.filter(f => f.name.toLowerCase().includes(qLower))

            if (matched.length === 0) {
                const names = all.slice(0, 20).map(f => f.name).join('、')
                return `【群文件下载失败】未找到名为「${query}」的群文件。\n群文件区现有（最多列20个）：${names}`
            }
            if (matched.length > 1) {
                const names = matched.map(f => f.name).join('、')
                return `【群文件下载失败】匹配到多个文件，请提供更精确的文件名：${names}`
            }

            const target = matched[0]
            const dirResult = resolveSaveDir(args.save_dir)
            if (dirResult.error) return `【群文件下载失败】${dirResult.error}`

            let url
            try {
                url = await getFileUrl(event, target.fileId, target.busid)
            } catch (err) {
                return `【群文件下载失败】获取文件下载链接失败: ${err.message}`
            }
            if (!url || typeof url !== 'string') {
                return `【群文件下载失败】未能获取到文件「${target.name}」的下载链接。`
            }

            const dl = await downloadUrl(url, dirResult.dir, target.name)
            if (!dl.ok) {
                return `【群文件下载失败】文件「${target.name}」下载失败: ${dl.reason}`
            }

            return {
                ok: true,
                fileName: dl.fileName,
                originName: target.name,
                dir: dirResult.dir,
                filePath: dl.filePath,
                size: dl.size
            }
        } catch (err) {
            logger.error('[AI-Plugin] 群文件下载异常:', err)
            return `【群文件下载失败】${err.message}`
        }
    },

    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data || !data.ok) return String(data || '')
        const mb = (data.size / 1024 / 1024).toFixed(2)
        return `\n\n【群文件下载成功】已将群文件「${data.originName}」下载到服务器。\n保存路径：${data.filePath}\n大小：${mb}MB\n请把保存结果如实告知主人。`
    }
}

// 自动注册
toolRegistry.register(groupFileListTool)
toolRegistry.register(groupFileDownloadTool)

