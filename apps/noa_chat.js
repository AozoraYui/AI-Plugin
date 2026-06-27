import crypto from 'node:crypto'
import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { checkAccess } from '../utils/access.js'
import { getBeijingTimeStr, getTodayDateStr, takeSourceMsg } from '../utils/common.js'
import { processImagesInBatches } from '../utils/image.js'
import { buildEnvironmentHint, expandForwardMsg, extractCardInfo } from './chat.js'

const replyCooldown = new Map()
const PERSONAL_MEMORY_MAX_CHARS = 2600
const PERSONAL_HISTORY_CONTEXT_MAX_CHARS = 2600

function truncateText(text, maxLength = 900) {
    const value = String(text || '').trim()
    if (value.length <= maxLength) return value
    return value.slice(0, maxLength) + '...'
}

function getMessageId(e) {
    const directId = e.message_id ?? e.seq ?? e.source?.seq
    if (directId !== undefined && directId !== null && directId !== '') return directId
    return `${e.group_id || 'private'}_${e.user_id}_${e.time || Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function getSenderName(e) {
    return e.sender?.card || e.sender?.nickname || e.member?.card || e.member?.nickname || `用户${e.user_id}`
}

function getBotUin(e) {
    return String(e.self_id || e.bot?.uin || e.bot?.self_id || (typeof Bot !== 'undefined' ? Bot.uin : '') || '')
}

function getImageUrl(seg) {
    return seg?.data?.url || seg?.url || seg?.file || seg?.data?.file || ''
}

function imageMetaFromUrl(url, source = 'message') {
    const hash = crypto.createHash('sha1').update(String(url)).digest('hex')
    return { url, hash, source }
}

function getForwardResid(seg) {
    if (seg.type === 'forward') return seg.data?.id || seg.id || ''
    if ((seg.type === 'json' || seg.type === 'xml') && seg.data) {
        const raw = typeof seg.data === 'string' ? seg.data : JSON.stringify(seg.data)
        return raw.match(/resid"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)?.[1]
            || raw.match(/template-id"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)?.[1]
            || ''
    }
    return ''
}

async function normalizeSegments(e, segments = [], source = 'message') {
    const textParts = []
    const imageMeta = []

    for (const seg of segments) {
        if (seg.type === 'reply') continue

        if (seg.type === 'text') {
            const text = seg.data?.text || seg.text || ''
            if (text) textParts.push(text)
            continue
        }

        if (seg.type === 'at') {
            const qq = seg.data?.qq || seg.qq
            if (qq) textParts.push(`[@${qq}]`)
            continue
        }

        if (seg.type === 'image') {
            const url = getImageUrl(seg)
            textParts.push('[图片]')
            if (url) imageMeta.push(imageMetaFromUrl(url, source))
            continue
        }

        if (seg.type === 'file') {
            const fileName = seg.name || seg.file_name || seg.fileName || seg.data?.name || seg.data?.file_name || seg.file || seg.data?.file || ''
            textParts.push(fileName ? `[文件：${fileName}]` : '[文件]')
            continue
        }

        const resid = getForwardResid(seg)
        if (resid) {
            try {
                const expanded = await expandForwardMsg(e.bot, resid)
                if (expanded.text) textParts.push(`[合并转发]\n${expanded.text}`)
                for (const url of expanded.images || []) {
                    imageMeta.push(imageMetaFromUrl(url, 'forward'))
                }
            } catch (err) {
                textParts.push(`[合并转发展开失败：${err.message}]`)
            }
            continue
        }

        if ((seg.type === 'json' || seg.type === 'xml') && seg.data) {
            let data = seg.data
            if (typeof data === 'string') {
                try { data = JSON.parse(data) } catch { data = null }
            }
            if (data && typeof data === 'object') {
                const cardInfo = extractCardInfo(data)
                if (cardInfo) textParts.push(`[卡片消息]\n${cardInfo}`)
            } else {
                textParts.push('[卡片消息]')
            }
        }
    }

    return {
        text: textParts.join('').replace(/\n{3,}/g, '\n\n').trim(),
        imageMeta
    }
}

async function normalizeGroupMessage(e) {
    const current = await normalizeSegments(e, e.message || [], 'message')
    let normalizedText = current.text || String(e.msg || '').trim()
    const imageMeta = [...current.imageMeta]

    const hasReply = Boolean(e.source || e.message?.some(seg => seg.type === 'reply'))
    if (hasReply) {
        try {
            const sourceMsg = await takeSourceMsg(e)
            if (sourceMsg?.message) {
                const reply = await normalizeSegments(e, sourceMsg.message, 'reply')
                if (reply.text) {
                    normalizedText += `${normalizedText ? '\n' : ''}=== 引用消息 ===\n${reply.text}`
                }
                imageMeta.push(...reply.imageMeta)
            }
        } catch (err) {
            logger.warn(`[AI-Plugin] [畅聊] 引用消息归一化失败: ${err.message}`)
        }
    }

    if (!normalizedText && imageMeta.length > 0) normalizedText = '[图片]'

    return {
        groupId: String(e.group_id),
        messageId: String(getMessageId(e)),
        seq: e.seq || e.source?.seq || '',
        userId: String(e.user_id),
        nickname: getSenderName(e),
        normalizedText,
        imageMeta,
        isCommand: String(e.msg || '').trim().startsWith('#'),
        isBot: String(e.user_id) === getBotUin(e)
    }
}

function isImageQuestion(text) {
    return /(图|图片|截图|照片|表情|刚才那张|这张|那张|看一下|看看)/i.test(text || '')
}

function isContextSummaryQuestion(text) {
    const value = String(text || '')
    return /(之前|前面|刚才|刚刚|最近|上面|他们|大家|群里).{0,20}(聊|说|发|讨论|发生|干嘛|在干嘛|干了啥|聊了啥|说了啥|发了啥|什么情况)/i.test(value)
        || /(聊了啥|聊了什么|说了啥|发了啥|发生了什么|什么情况|前情提要|总结.{0,12}群聊|群聊.{0,12}总结)/i.test(value)
}

function shouldTriggerNoa(e, normalizedText) {
    const botUin = getBotUin(e)
    const mentionedBot = e.message?.some(seg => seg.type === 'at' && String(seg.data?.qq || seg.qq) === botUin)
    if (mentionedBot) return true

    const keywords = new Set([
        Config.AI_NAME,
        ...Config.NOA_CHAT_TRIGGER_KEYWORDS,
        '诺亚',
        'noa'
    ].filter(Boolean).map(s => String(s).toLowerCase()))
    const lower = String(normalizedText || '').toLowerCase()
    return [...keywords].some(keyword => keyword && lower.includes(keyword))
}

function formatGroupContext(logs = []) {
    const lines = []
    for (const log of logs) {
        const name = log.isBot ? Config.AI_NAME : (log.nickname || `用户${log.userId}`)
        const imageHint = log.imageMeta?.length ? `（含 ${log.imageMeta.length} 张图片）` : ''
        lines.push(`[${log.createdAt}] ${name}(${log.userId}): ${truncateText(log.normalizedText, 700)}${imageHint}`)
    }
    return lines.join('\n')
}

function collectRecentImageUrls(logs = [], limit = 3) {
    const urls = []
    for (const log of [...logs].reverse()) {
        for (const item of log.imageMeta || []) {
            if (item.url && !urls.includes(item.url)) urls.push(item.url)
            if (urls.length >= limit) return urls
        }
    }
    return urls
}

function cleanModelText(text) {
    let result = String(text || '').trim()
    if (Config.show_thinking) return result
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    const blocks = result.split('\n\n')
    const firstContent = blocks.findIndex(block => {
        const trimmed = block.trim()
        return trimmed && !trimmed.startsWith('*Thinking') && !trimmed.startsWith('>')
    })
    return firstContent >= 0 ? blocks.slice(firstContent).join('\n\n').replace(/^>\s*/, '').trim() : result
}

export class NoaChatHandler extends plugin {
    constructor() {
        super({
            name: 'AI畅聊',
            dsc: '群消息捕获与诺亚触发回复',
            event: 'message',
            priority: 10000,
            rule: [
                { reg: /^.*$/s, fnc: 'handleNoaChat', log: false }
            ]
        })
        this.client = global.AIPluginClient
        this.conversationManager = global.AIPluginConversationManager
    }

    async handleNoaChat(e) {
        if (!this.client?.enableNoaChat && Config.enable_noa_chat !== true) return false
        if (!e.group_id || !e.message || !Array.isArray(e.message)) return false
        if (!await checkAccess(e)) return false

        const normalized = await normalizeGroupMessage(e)
        if (!normalized.normalizedText) return false

        try {
            const changes = await this.conversationManager.db.saveGroupMessageLog(normalized)
            if (changes > 0) {
                logger.debug(`[AI-Plugin] [畅聊] 已捕获群消息: 群 ${normalized.groupId}, 用户 ${normalized.userId}, 图片=${normalized.imageMeta.length}`)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] [畅聊] 保存群消息失败:`, err)
        }

        if (normalized.isBot || normalized.isCommand) return false
        if (!shouldTriggerNoa(e, normalized.normalizedText)) return false

        const cooldownMs = Math.max(0, Number(Config.NOA_CHAT_REPLY_COOLDOWN_MS) || 0)
        const cooldownKey = String(e.group_id)
        const now = Date.now()
        const lastReplyAt = replyCooldown.get(cooldownKey) || 0
        if (cooldownMs > 0 && now - lastReplyAt < cooldownMs) {
            logger.info(`[AI-Plugin] [畅聊] 触发命中但仍在冷却中: 群 ${e.group_id}`)
            return true
        }
        replyCooldown.set(cooldownKey, now)

        try {
            await this.replyWithGroupContext(e, normalized)
        } catch (err) {
            logger.error(`[AI-Plugin] [畅聊] 回复失败:`, err)
        }
        return true
    }

    async replyWithGroupContext(e, normalized) {
        const limit = Math.max(10, Number(Config.NOA_CHAT_CONTEXT_LIMIT) || 60)
        const logs = await this.conversationManager.db.getRecentGroupMessageLogs(e.group_id, limit, { excludeCommands: true })
        const contextText = formatGroupContext(logs)
        let memoryData = null
        let personalMemory = ''
        try {
            memoryData = await this.conversationManager.getUserHistoryWithCheckpoint(normalized.userId)
            personalMemory = truncateText(memoryData?.incrementalCheckpoint || '', PERSONAL_MEMORY_MAX_CHARS)
            if (personalMemory) {
                logger.info(`[AI-Plugin] [畅聊] 已加载触发者个人记忆摘要: 用户 ${normalized.userId}, 字符数=${personalMemory.length}`)
            }
        } catch (err) {
            logger.warn(`[AI-Plugin] [畅聊] 加载触发者个人记忆摘要失败: ${err.message}`)
        }
        const shouldReadRecentImages = isImageQuestion(normalized.normalizedText) || isContextSummaryQuestion(normalized.normalizedText)
        const imageUrls = shouldReadRecentImages
            ? collectRecentImageUrls(logs, Math.max(0, Number(Config.NOA_CHAT_MAX_CONTEXT_IMAGES) || 0))
            : []
        const imageParts = imageUrls.length > 0 ? await processImagesInBatches(imageUrls) : []

        if (imageUrls.length > 0) {
            logger.info(`[AI-Plugin] [畅聊] 本轮按需读取最近图片 ${imageParts.length}/${imageUrls.length} 张，原因=${isImageQuestion(normalized.normalizedText) ? '图片相关提问' : '群聊上下文总结'}`)
        }

        const environmentHint = buildEnvironmentHint(e)
        logger.info(`[AI-Plugin] [畅聊] 环境提示: ${environmentHint}`)

        const prompt = `你是 ${Config.AI_NAME}，正在一个 QQ 群里自然聊天。

请基于下面的群聊上下文回复当前触发你的用户。你能看到最近群聊流水，但要注意：
- 不要逐字复述大段历史，像正常群友一样自然接话。
- 图片在长期记录里只以 [图片] 和元信息存在；如果本轮附带了图片输入，可以基于实际看到的图片回答。
- 如果当前用户在问“之前聊了什么/发生了什么/前情提要”，请结合最近群聊文本和本轮附带的最近图片一起概括；没有记录就直接说明只能看到启用畅聊后捕获到的内容。
- “触发者个人记忆摘要”只用于理解当前触发者的偏好、称呼和长期上下文；具体隐私边界以当前聊天环境提示为准。
- 不要编造没有出现在上下文里的事实。
- 如果上下文不足，就坦诚说不太确定。

【当前时间】
${getBeijingTimeStr()}

【最近群聊上下文】
${contextText || '暂无'}

${personalMemory ? `【触发者个人记忆摘要】\n${personalMemory}\n\n` : ''}【当前触发消息】
${normalized.nickname}(${normalized.userId}): ${normalized.normalizedText}`

        const contents = [
            ...Config.personaPrimer,
            {
                role: 'user',
                parts: [{ text: environmentHint }]
            },
            {
                role: 'model',
                parts: [{ text: '好的，我已经了解当前的聊天环境，会根据环境调整我的行为！' }]
            },
            {
                role: 'user',
                parts: [{ text: prompt }, ...imageParts]
            }
        ]

        const result = await this.client.makeRequest('chat', { contents }, 'flash', 4096)
        if (!result.success || !result.data) {
            await e.reply(`❌ 畅聊回复失败: ${result.error || '模型无返回'}`, true)
            return
        }

        const replyText = cleanModelText(result.data)
        await e.reply(replyText, true)
        await this.saveNoaChatToPersonalHistory(e, normalized, contextText, replyText, memoryData?.history)

        try {
            await this.conversationManager.db.saveGroupMessageLog({
                groupId: String(e.group_id),
                messageId: `noa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                userId: getBotUin(e) || 'bot',
                nickname: Config.AI_NAME,
                normalizedText: replyText,
                imageMeta: [],
                isCommand: false,
                isBot: true
            })
        } catch (err) {
            logger.warn(`[AI-Plugin] [畅聊] 保存 AI 回复到群流水失败: ${err.message}`)
        }
    }

    async saveNoaChatToPersonalHistory(e, normalized, contextText, replyText, existingHistory = null) {
        const userId = String(normalized.userId)
        try {
            const history = Array.isArray(existingHistory)
                ? existingHistory
                : (await this.conversationManager.getUserHistoryWithCheckpoint(userId)).history
            const groupName = e.group_name || e.group?.name || e.sender?.group_name || `群 ${normalized.groupId}`
            const memoryText = [
                '【畅聊模式记录】以下内容来自群聊畅聊模式，已同步到个人对话记忆，供后续普通 #c 对话延续上下文。',
                `群聊：${groupName}(${normalized.groupId})`,
                `触发者：${normalized.nickname}(${userId})`,
                `触发消息：${normalized.normalizedText}`,
                contextText ? `当时最近群聊上下文：\n${truncateText(contextText, PERSONAL_HISTORY_CONTEXT_MAX_CHARS)}` : '',
                '注意：这是一段群聊公开上下文记录，回复时仍需遵守当前聊天环境的隐私规则。'
            ].filter(Boolean).join('\n')

            const updatedHistory = [
                ...history,
                { role: 'user', parts: [{ text: memoryText }] },
                { role: 'model', parts: [{ text: replyText }] }
            ]
            await this.conversationManager.saveUserHistory(userId, updatedHistory)
            logger.info(`[AI-Plugin] [畅聊] 已同步畅聊记录到用户 ${userId} 的普通对话记忆`)

            const summaryCounter = await this.conversationManager.advanceAutoSummaryCounter(userId)
            if (summaryCounter.disabled) {
                logger.debug(`[AI-Plugin] [畅聊] 自动增量总结已关闭: AUTO_SUMMARY_THRESHOLD=${Config.AUTO_SUMMARY_THRESHOLD}`)
            } else if (!summaryCounter.error) {
                logger.info(`[AI-Plugin] [畅聊] 用户 ${userId} 自动增量总结计数: ${summaryCounter.count}/${summaryCounter.threshold} 轮`)
            }

            if (summaryCounter.shouldTrigger) {
                logger.info(`[AI-Plugin] [畅聊] 用户 ${userId} 距上次增量总结已达 ${summaryCounter.count} 轮，自动触发增量总结`)
                const todayStr = getTodayDateStr()
                await this.conversationManager.createIncrementalCheckpoint(userId, todayStr, 0, 'flash')
                await this.conversationManager.resetAutoSummaryCounter(userId)
                logger.info(`[AI-Plugin] [畅聊] 用户 ${userId} 增量总结完成，自动总结计数已重置`)
            }
        } catch (err) {
            logger.warn(`[AI-Plugin] [畅聊] 同步畅聊记录到普通对话记忆失败: ${err.message}`)
        }
    }
}
