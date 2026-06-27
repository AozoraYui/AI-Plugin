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
import { setMsgEmojiLike, takeSourceMsg, getAvatarUrl, urlToBuffer, getImageMimeType, resolveModelDisplay } from '../utils/common.js'
import { processImagesInBatches } from '../utils/image.js'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'

// 角色参考图库目录：插件根目录 data/characters/{角色ID}/profile.yaml + 0.png/1.png...
const CHARACTER_ROOT_DIR = path.join(process.cwd(), 'plugins', 'AI-Plugin', 'data', 'characters')
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
// 每个角色最多取用的本地参考图数量（过多会让 /images/edits 上传超时）
const CHARACTER_MAX_REF = 1

function imageMime(ext) {
    const e = ext.toLowerCase()
    if (e === '.png') return 'image/png'
    if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
    if (e === '.webp') return 'image/webp'
    if (e === '.gif') return 'image/gif'
    return 'image/png'
}

function normalizeCharacterKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
}

function readCharacterProfile(dir, fallback = {}) {
    const profilePath = path.join(dir, 'profile.yaml')
    if (!fs.existsSync(profilePath)) return fallback
    try {
        const data = yaml.parse(fs.readFileSync(profilePath, 'utf8')) || {}
        return {
            ...fallback,
            ...data,
            aliases: Array.isArray(data.aliases) ? data.aliases : (fallback.aliases || [])
        }
    } catch (err) {
        logger.warn(`[AI-Plugin] 画图工具：读取角色 profile.yaml 失败 ${profilePath}: ${err.message}`)
        return fallback
    }
}

function resolveCharacterProfile(inputCharacter, isSelfPortrait = false) {
    const raw = String(inputCharacter || '').trim()
    const normalized = normalizeCharacterKey(raw)
    const requested = isSelfPortrait ? 'noa' : (normalized || raw)
    if (!requested) return null

    // 新结构：data/characters/{id}
    if (fs.existsSync(CHARACTER_ROOT_DIR)) {
        const dirs = fs.readdirSync(CHARACTER_ROOT_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
        for (const dirName of dirs) {
            const dir = path.join(CHARACTER_ROOT_DIR, dirName)
            const profile = readCharacterProfile(dir, { id: dirName, name: dirName, aliases: [] })
            const candidates = [dirName, profile.id, profile.name, ...(profile.aliases || [])]
                .filter(Boolean)
                .map(v => normalizeCharacterKey(v))
            // 中文别名 normalize 后可能为空，所以额外做原文精确匹配
            const rawCandidates = [dirName, profile.id, profile.name, ...(profile.aliases || [])]
                .filter(Boolean)
                .map(v => String(v).trim())
            if (candidates.includes(requested) || (raw && rawCandidates.includes(raw))) {
                return { ...profile, id: dirName, dir, legacy: false }
            }
        }
    }

    return null
}

// 读取角色参考图，转为 AI 可用的 inline_data 数组（本地文件不走 fetch）
function loadCharacterImages(characterProfile) {
    try {
        if (!characterProfile?.dir || !fs.existsSync(characterProfile.dir)) return []
        const files = fs.readdirSync(characterProfile.dir)
            .filter(f => IMG_EXT.includes(path.extname(f).toLowerCase()))
        if (files.length === 0) return []
        const picked = shuffleInPlace(files).slice(0, CHARACTER_MAX_REF)
        const parts = []
        const usedNames = []
        for (const f of picked) {
            try {
                const buf = fs.readFileSync(path.join(characterProfile.dir, f))
                parts.push({ inline_data: { mime_type: imageMime(path.extname(f)), data: buf.toString('base64') } })
                usedNames.push(f)
            } catch (err) {
                logger.warn(`[AI-Plugin] 画图工具：读取角色参考图 ${characterProfile.id}/${f} 失败: ${err.message}`)
            }
        }
        parts.usedNames = usedNames
        return parts
    } catch (err) {
        logger.warn(`[AI-Plugin] 画图工具：加载角色参考图失败: ${err.message}`)
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
    const currentImages = (event.message || []).filter(m => m.type === 'image').map(m => m.data?.url || m.url).filter(Boolean)
    if (currentImages.length > 0) images = images.concat(currentImages)
    // 3. @成员头像（回复消息时跳过 QQ 自动加的第一个 @）
    const hasReply = event.source || event.message?.find(m => m.type === 'reply')
    let atSegments = (event.message || []).filter(m => m.type === 'at' && (m.qq || m.data?.qq))
    if (hasReply && atSegments.length > 0) atSegments = atSegments.slice(1)
    for (const atSeg of atSegments) {
        try { images.push(await getAvatarUrl(atSeg.qq || atSeg.data?.qq)) } catch { /* ignore */ }
    }
    if (images.length > 0) {
        logger.info(`[AI-Plugin] 画图工具：从当前/引用/@ 收集到 ${images.length} 张参考图`)
    }
    return { images, hasReply }
}

function shouldUseCachedReferenceImage(args = {}, event = {}) {
    const text = [
        args.prompt,
        args.preset,
        event.raw_message,
        event.msg
    ].filter(Boolean).join('\n')
    return /(刚才|上次|之前|上一张|这张|那张|原图|参考图|图片|图里|截图|处理|修改|编辑|去掉|去除|移除|擦除|消除|水印|二维码|背景|重绘|修图|绘图功能|画图功能|调用绘图|调用画图|p模型|pro模型|inpaint|inpainting)/i.test(text)
}

async function loadCachedReferenceImages(event, args = {}) {
    if (!shouldUseCachedReferenceImage(args, event)) return []
    if (typeof redis === 'undefined' || !redis.get) return []

    const keys = event.group_id
        ? [
            `AI-Plugin:lastImages:group:${event.group_id}:user:${event.user_id}`,
            `AI-Plugin:lastImages:group:${event.group_id}`
        ]
        : [`AI-Plugin:lastImages:private:${event.user_id}`]

    for (const key of keys) {
        try {
            const raw = await redis.get(key)
            if (!raw) continue
            const record = JSON.parse(raw)
            const images = Array.isArray(record.images) ? record.images.filter(Boolean) : []
            if (images.length > 0) {
                logger.info(`[AI-Plugin] 画图工具：从最近图片缓存恢复 ${images.length} 张参考图 (${key})`)
                return images
            }
        } catch (err) {
            logger.warn(`[AI-Plugin] 画图工具：读取最近图片缓存失败: ${err.message}`)
        }
    }
    return []
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
    description: '调用插件自身的 AI 画图能力生成图片并直接发送到当前会话。适合用户说"画一个/帮我画/生成一张图/用某某风格画"，也可尝试基于参考图重绘、修图、去水印/二维码或套预设（不保证精准像素级编辑）。支持参考图（用户带图、引用图片、@成员头像、最近图片缓存）和角色参考图库（data/characters）。支持预设风格名。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'draw_image',
            description: '生成图片并发送到当前会话。可带文字描述和/或预设风格名；参考图自动从当前消息、引用消息、@头像或最近图片缓存中提取。',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: '画图或参考图处理的文字描述/提示词。用户要求画什么、如何改图、保留什么、去掉什么就填什么。若仅套用预设可留空。'
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
                        description: '可选。当用户要求"画你自己/画 AI 本人/给我看看你长什么样"等指向 AI 自身形象时设为 true，等价于 character="noa"。普通画图请勿设置或设为 false。'
                    },
                    character: {
                        type: 'string',
                        description: '可选，角色参考图库中的单个角色ID或别名（如 noa、yuuka、maki、rio，或 profile.yaml 中配置的 aliases）。用户只要求画一个已配置角色时填写；工具会自动加载 data/characters/{角色ID} 下的参考图和设定。'
                    },
                    characters: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '可选，多个角色ID或别名数组。用户要求同一画面出现多个已配置角色时填写，例如 ["noa", "yuuka"]；工具会为每个角色各加载一张参考图。'
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
        const rawCharacters = Array.isArray(args.characters) ? args.characters : []
        const characterInputs = isSelfPortrait
            ? ['noa']
            : [...rawCharacters, args.character]
                .map(v => String(v || '').trim())
                .filter(Boolean)
                .filter((v, i, arr) => arr.findIndex(x => (normalizeCharacterKey(x) || x) === (normalizeCharacterKey(v) || v)) === i)
        const characterProfiles = characterInputs
            .map(input => resolveCharacterProfile(input, isSelfPortrait && input === 'noa'))
            .filter(Boolean)

        // 角色参考图：每个角色从 data/characters/{角色ID} 各取一张，锁定多角色形象
        const characterImageGroups = characterProfiles.map(profile => ({ profile, images: loadCharacterImages(profile) }))
        const characterImages = characterImageGroups.flatMap(group => group.images)
        for (const group of characterImageGroups) {
            const usedNames = group.images.usedNames || []
            const nameNote = usedNames.length > 0 ? `：${usedNames.join('、')}` : ''
            logger.info(`[AI-Plugin] 画图工具：角色参考模式「${group.profile.name || group.profile.id}」，加载到 ${group.images.length} 张本地参考图${nameNote}`)
        }
        for (const input of characterInputs) {
            if (!characterProfiles.some(profile => normalizeCharacterKey(profile.id) === normalizeCharacterKey(input) || normalizeCharacterKey(profile.name) === normalizeCharacterKey(input) || (profile.aliases || []).some(alias => normalizeCharacterKey(alias) === normalizeCharacterKey(input) || String(alias).trim() === input))) {
                logger.warn(`[AI-Plugin] 画图工具：未找到角色参考图库「${input}」，将仅使用文本/用户参考图画图`)
            }
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
        if (refImages.length === 0) {
            refImages.push(...await loadCachedReferenceImages(event, args))
        }
        // 无参考图、无描述、无预设、也没有角色参考图时，无法判断画什么
        if (refImages.length === 0 && characterImages.length === 0 && !prompt && !preset) {
            return '【画图失败】没有可用的画图内容：请提供文字描述，或附带/引用图片，或@某位成员。'
        }
        // 纯预设且无图时，默认用发送者头像作为参考（与 #draw 行为一致）
        if (refImages.length === 0 && characterImages.length === 0 && preset && !prompt && !hasReply) {
            try { refImages.push(await getAvatarUrl(event.user_id)) } catch { /* ignore */ }
        }

        const imagesToProcess = refImages.slice(0, Config.MAX_IMAGES_PER_MESSAGE)

        try {
            await setMsgEmojiLike(event, 282)
            const modelDisplay = resolveModelDisplay(modelGroupKey)
            await event.reply(`🎨 正在生成 (使用 ${modelDisplay} 模型组)，请稍候…`)

            const parts = []
            // 角色图库参考图优先放最前，锁定目标角色形象
            if (characterImages.length > 0) parts.push(...characterImages)
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
            // 角色参考：补充形象指令，引导模型区分角色图库参考图与用户额外参考图
            if (characterProfiles.length > 0) {
                const characterNames = characterProfiles.map(profile => profile.name || profile.id)
                const refRanges = []
                let refStart = 1
                for (const group of characterImageGroups) {
                    const count = group.images.length
                    const name = group.profile.name || group.profile.id
                    if (count > 0) {
                        const refEnd = refStart + count - 1
                        refRanges.push(count === 1 ? `参考图#${refStart} 是角色「${name}」` : `参考图#${refStart}-#${refEnd} 是角色「${name}」`)
                        refStart += count
                    }
                }

                let refHint = ''
                if (characterImages.length > 0 && processedImages.length > 0) {
                    refHint = `请注意参考图顺序：${refRanges.join('；')}。这些是角色官方/设定参考图，必须分别保持对应角色的发型发色、瞳色、光环、服饰等关键特征一致，不要混淆角色；后续 ${processedImages.length} 张是用户额外提供的参考图，仅用于场景、姿势、构图、镜头、氛围或风格参考，不要把后续参考图中的人物身份/外貌替换成目标角色。`
                } else if (characterImages.length > 0) {
                    refHint = `请严格按顺序参考随附角色图：${refRanges.join('；')}。请在同一画面中分别保持每个角色的发型发色、瞳色、光环、服饰等关键特征一致，不要把多个角色的外貌混在一起。`
                } else if (processedImages.length > 0) {
                    refHint = `用户提供了 ${processedImages.length} 张额外参考图，请仅用于场景、姿势、构图、镜头、氛围或风格参考；角色「${characterNames.join('、')}」的形象仍以文字设定为准。`
                }
                const descLines = characterProfiles
                    .map(profile => {
                        const name = profile.name || profile.id
                        return profile.description ? `角色设定（${name}）：${profile.description}` : `目标角色：${name}`
                    })
                    .join('\n')
                const characterText = `${refHint}\n${descLines}`.trim()
                finalText = finalText ? `${characterText}\n在此基础上：${finalText}` : characterText
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
                let reviewImage = null
                if (result.data.startsWith('data:image/')) {
                    const match = result.data.match(/^data:(image\/[^;]+);base64,(.+)$/)
                    if (match) {
                        reviewImage = { mime_type: match[1], data: match[2] }
                        imageToSend = `base64://${match[2]}`
                    } else {
                        imageToSend = `base64://${result.data.split(',')[1]}`
                    }
                } else {
                    try {
                        const arr = await urlToBuffer(result.data)
                        const buf = Buffer.from(arr)
                        const mimeType = getImageMimeType(buf) || 'image/png'
                        const data = buf.toString('base64')
                        reviewImage = { mime_type: mimeType, data }
                        imageToSend = `base64://${data}`
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
                    characters: characterProfiles.map(profile => profile.name || profile.id),
                    character: characterProfiles.length === 1 ? (characterProfiles[0].name || characterProfiles[0].id) : null,
                    refCount: processedImages.length,
                    characterRefCount: characterImages.length,
                    reviewImage
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
        const characterNames = Array.isArray(data.characters) && data.characters.length > 0
            ? data.characters
            : (data.character ? [data.character] : [])
        const characterNote = characterNames.length > 0 ? `，角色「${characterNames.join('、')}」` : ''
        const characterRefNote = data.characterRefCount > 0 ? `，角色参考图 ${data.characterRefCount} 张` : ''
        const refNote = data.refCount > 0 ? `，用户参考图 ${data.refCount} 张` : ''
        return `\n\n【画图成功】已生成图片并发送到当前会话（耗时 ${data.elapsed}s${presetNote}${characterNote}${characterRefNote}${refNote}）。`
    }
}

// 自动注册
toolRegistry.register(imageGenTool)
