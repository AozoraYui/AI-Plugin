/**
 * AI 画图工具
 * 让 AI 在对话中按意图联动插件自身的画图能力：
 *   - 支持自由描述（等同 #draw [描述]）
 *   - 支持预设名识别（用某某风格画）
 *   - 图片来源：当前消息带图、引用消息的图、@成员头像，默认无图时用发送者头像
 * 工具直接把生成的图发到当前会话，同时向主模型返回结果说明。
 */

import { toolRegistry } from './registry.js'
import { Config } from '../utils/config.js'
import { setMsgEmojiLike, takeSourceMsg, getAvatarUrl, urlToBuffer, resolveModelGroup, resolveModelDisplay } from '../utils/common.js'
import { processImagesInBatches } from '../utils/image.js'
import fs from 'node:fs'
import path from 'node:path'

// 自画像参考图目录：插件根目录 data/self（放 0.png / 1.png / 2.png 等官方参考图）
const SELF_PORTRAIT_DIR = path.join(process.cwd(), 'plugins', 'AI-Plugin', 'data', 'self')
const SELF_IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
// 画自己时最多取用的本地参考图数量（过多会让 /images/edits 上传超时，曾出现 12/4 张触发 524）
const SELF_PORTRAIT_MAX_REF = 2

function selfMime(ext) {
    const e = ext.toLowerCase()
    if (e === '.png') return 'image/png'
    if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
    if (e === '.webp') return 'image/webp'
    if (e === '.gif') return 'image/gif'
    return 'image/png'
}

// 读取本地自画像参考图，转为 AI 可用的 inline_data 数组（本地文件不走 fetch）
// 为避免参考图过多导致上游 /images/edits 超时，从所有图中随机挑选最多 SELF_PORTRAIT_MAX_REF 张
function loadSelfPortraitImages() {
    try {
        if (!fs.existsSync(SELF_PORTRAIT_DIR)) return []
        const files = fs.readdirSync(SELF_PORTRAIT_DIR)
            .filter(f => SELF_IMG_EXT.includes(path.extname(f).toLowerCase()))
        if (files.length === 0) return []
        // 随机洗牌（Fisher-Yates）后取前 N 张，让每次画自己参考的角度不同
        for (let i = files.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[files[i], files[j]] = [files[j], files[i]]
        }
        const picked = files.slice(0, SELF_PORTRAIT_MAX_REF)
        const parts = []
        const usedNames = []
        for (const f of picked) {
            try {
                const buf = fs.readFileSync(path.join(SELF_PORTRAIT_DIR, f))
                parts.push({ inline_data: { mime_type: selfMime(path.extname(f)), data: buf.toString('base64') } })
                usedNames.push(f)
            } catch (err) {
                logger.warn(`[AI-Plugin] 画图工具：读取自画像参考图 ${f} 失败: ${err.message}`)
            }
        }
        // 把实际使用的文件名挂到数组上，供调用处打印日志（不影响请求体）
        parts.usedNames = usedNames
        return parts
    } catch (err) {
        logger.warn(`[AI-Plugin] 画图工具：加载自画像参考图失败: ${err.message}`)
        return []
    }
}

// 从事件对象收集画图参考图：引用图 + 当前消息图 + @成员头像
async function collectReferenceImages(event) {
    let images = []
    // 1. 引用消息中的图片
    try {
        const replyImages = await takeSourceMsg(event, { img: true })
        if (replyImages) images = images.concat(replyImages)
    } catch (err) {
        logger.warn(`[AI-Plugin] 画图工具：获取引用图失败: ${err.message}`)
    }
    // 2. 当前消息中的图片
    const currentImages = (event.message || []).filter(m => m.type === 'image').map(m => m.url)
    if (currentImages.length > 0) images = images.concat(currentImages)
    // 3. @成员头像（回复消息时跳过 QQ 自动加的第一个 @）
    const hasReply = event.source || event.message?.find(m => m.type === 'reply')
    let atSegments = (event.message || []).filter(m => m.type === 'at' && m.qq)
    if (hasReply && atSegments.length > 0) atSegments = atSegments.slice(1)
    for (const atSeg of atSegments) {
        try { images.push(await getAvatarUrl(atSeg.qq)) } catch { /* ignore */ }
    }
    return { images, hasReply }
}

// 按预设名/别名查找预设（不区分大小写）
function findPreset(presetName) {
    if (!presetName) return null
    const q = String(presetName).trim().toLowerCase()
    if (!q) return null
    const presets = Config.presets || []
    return presets.find(p =>
        p.command?.toLowerCase() === q ||
        p.name?.toLowerCase() === q ||
        (Array.isArray(p.aliases) && p.aliases.map(a => a.toLowerCase()).includes(q))
    ) || null
}

export const imageGenTool = {
    name: 'draw_image',
    permission: 'everyone',
    description: '调用插件自身的 AI 画图能力生成图片并直接发送到当前会话。适合用户说"画一个/帮我画/生成一张图/用某某风格画"等。支持参考图（用户带图、引用图片、@成员取头像作为参考）。支持预设风格名。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'draw_image',
            description: '生成图片并发送到当前会话。可带文字描述和/或预设风格名；参考图自动从消息中提取。',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: '画图的文字描述/提示词。用户要求画什么就填什么。若仅套用预设可留空。'
                    },
                    preset: {
                        type: 'string',
                        description: '可选，预设风格名或指令名（如"手办化"）。用户明确提到某种已有风格时填写，否则留空。'
                    },
                    quality: {
                        type: 'string',
                        enum: ['flash', 'pro', 'ultra'],
                        description: '可选，画质/模型组。默认 flash。用户要求"高质量/精细/pro/ultra"时可调高。'
                    },
                    self_portrait: {
                        type: 'boolean',
                        description: '可选。当用户要求"画你自己/画 AI 本人/给我看看你长什么样"等指向 AI 自身形象时设为 true，工具会自动加载本地官方参考图来锁定形象。普通画图请勿设置或设为 false。'
                    }
                },
                required: []
            }
        }
    },

    async execute(args = {}, context = {}) {
        const event = context.event
        if (!event) return '【画图失败】缺少会话上下文，无法发送图片。'

        const client = global.AIPluginClient
        if (!client) return '【画图失败】AI 客户端未初始化。'

        const prompt = String(args.prompt || '').trim()
        const presetName = String(args.preset || '').trim()
        const modelGroupKey = ['flash', 'pro', 'ultra'].includes(args.quality) ? args.quality : 'flash'
        const isSelfPortrait = args.self_portrait === true || args.self_portrait === 'true'

        // 画自己：加载本地官方参考图（data/self），用以锁定形象
        const selfImages = isSelfPortrait ? loadSelfPortraitImages() : []
        if (isSelfPortrait) {
            const usedNames = selfImages.usedNames || []
            const nameNote = usedNames.length > 0 ? `：${usedNames.join('、')}` : ''
            logger.info(`[AI-Plugin] 画图工具：画自己模式，加载到 ${selfImages.length} 张本地参考图${nameNote}`)
        }

        // 解析预设
        let preset = null
        if (presetName) {
            preset = findPreset(presetName)
            if (!preset) {
                return `【画图失败】未找到名为「${presetName}」的预设。可用 #画图预设列表 查看，或直接用文字描述画图。`
            }
        }

        // 收集参考图
        const { images: refImages, hasReply } = await collectReferenceImages(event)
        // 无参考图、无描述、无预设、也没有自画像参考图时，无法判断画什么
        if (refImages.length === 0 && selfImages.length === 0 && !prompt && !preset) {
            return '【画图失败】没有可用的画图内容：请提供文字描述，或附带/引用图片，或@某位成员。'
        }
        // 纯预设且无图时，默认用发送者头像作为参考（与 #draw 行为一致）
        if (refImages.length === 0 && selfImages.length === 0 && preset && !prompt && !hasReply) {
            try { refImages.push(await getAvatarUrl(event.user_id)) } catch { /* ignore */ }
        }

        const imagesToProcess = refImages.slice(0, Config.MAX_IMAGES_PER_MESSAGE)

        try {
            await setMsgEmojiLike(event, 282)
            const modelDisplay = resolveModelDisplay(modelGroupKey)
            await event.reply(`🎨 正在生成 (使用 ${modelDisplay} 模型组)，请稍候…`)

            const parts = []
            // 画自己：本地官方参考图优先放最前，锁定形象
            if (selfImages.length > 0) parts.push(...selfImages)
            const processedImages = imagesToProcess.length > 0 ? await processImagesInBatches(imagesToProcess) : []
            if (imagesToProcess.length > 0 && processedImages.length === 0) {
                await setMsgEmojiLike(event, 10)
                return '【画图失败】参考图获取失败，请检查图片来源是否可访问，或稍后重试。'
            }
            parts.push(...processedImages)

            // 文本提示：预设 prompt + 用户补充描述
            let finalText = ''
            if (preset) {
                finalText = prompt ? `${preset.prompt} ${prompt}` : preset.prompt
            } else {
                finalText = prompt
            }
            // 画自己：补充形象指令，引导模型参照参考图
            if (isSelfPortrait) {
                const refHint = selfImages.length > 0
                    ? '请严格参考随附的参考图（这是你本人的官方形象），保持发型发色、瞳色、光环、服饰等关键特征一致。'
                    : ''
                const portraitDesc = Config.selfPortrait || ''
                const selfText = `${refHint}${portraitDesc ? '形象设定：' + portraitDesc : ''}`.trim()
                finalText = finalText ? `${selfText} 在此基础上：${finalText}` : selfText
            }
            if (finalText) parts.push({ text: finalText })

            if (parts.length === 0) {
                await setMsgEmojiLike(event, 10)
                return '【画图失败】没有可提交的画图内容。'
            }

            const payload = { contents: [{ parts }] }
            const startTime = Date.now()
            const result = await client.makeRequest('image', payload, modelGroupKey, 8192)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

            if (!result.success || !result.data) {
                await setMsgEmojiLike(event, 10)
                return `【画图失败】模型返回失败 (${elapsed}s): ${result.error || '未知错误'}`
            }

            // 返回的是图片（base64 / url）则发图；否则当作文本回复
            if (typeof result.data === 'string' && (result.data.startsWith('data:image/') || result.data.startsWith('http'))) {
                let imageToSend = result.data
                if (result.data.startsWith('data:image/')) {
                    imageToSend = `base64://${result.data.split(',')[1]}`
                } else {
                    try {
                        const buf = await urlToBuffer(result.data)
                        imageToSend = `base64://${buf.toString('base64')}`
                    } catch { /* 用原 url */ }
                }
                const caption = preset
                    ? `✅ 生成完成 (${elapsed}s)｜预设：${preset.name}${prompt ? ' + 自定义' : ''} @${result.platform}`
                    : `✅ 创作完成 (${elapsed}s) @${result.platform}`
                await event.reply([segment.image(imageToSend), caption], true)
                await setMsgEmojiLike(event, 144)
                return {
                    ok: true,
                    elapsed,
                    platform: result.platform,
                    preset: preset?.name || null,
                    refCount: processedImages.length
                }
            } else {
                // 模型只返回了文本（如拒绝/描述），交回文本
                await setMsgEmojiLike(event, 144)
                return `【画图结果（模型返回文本）】${String(result.data).trim()}`
            }
        } catch (err) {
            try { await setMsgEmojiLike(event, 10) } catch { /* ignore */ }
            logger.error('[AI-Plugin] 画图工具异常:', err)
            return `【画图失败】处理异常: ${err.message}`
        }
    },

    formatResult(data) {
        if (typeof data === 'string') return data
        if (!data || !data.ok) return String(data || '')
        const presetNote = data.preset ? `，预设「${data.preset}」` : ''
        const refNote = data.refCount > 0 ? `，参考图 ${data.refCount} 张` : ''
        return `\n\n【画图成功】已生成图片并发送到当前会话（耗时 ${data.elapsed}s${presetNote}${refNote}）。图片已直接发出，无需你再描述图片内容。`
    }
}

// 自动注册
toolRegistry.register(imageGenTool)

