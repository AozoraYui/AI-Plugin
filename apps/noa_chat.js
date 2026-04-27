import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { GeminiClient } from '../client/GeminiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess } from '../utils/access.js'
import { expandForwardMsg, extractImagesFromMsg } from './chat.js'
import { vectorDB } from '../utils/vector_db.js'
import { getImageMimeType, urlToBuffer } from '../utils/common.js'

const replyCooldown = new Map()

export class NoaChat extends plugin {
    constructor() {
        super({
            name: 'AI-Plugin-畅聊模式',
            dsc: '畅聊模式：监听所有消息，触发词回复',
            event: 'message',
            priority: 10000,
            rule: [
                {
                    reg: '^.*$',
                    fnc: 'handleNoaChat',
                    log: false
                }
            ]
        })

        this.client = new GeminiClient()
        this.conversationManager = new ConversationManager()
    }

    async handleNoaChat(e) {
        const noaConfig = Config.noaChatConfig
        if (!noaConfig.enabled) {
            return false
        }

        if (!e.msg || e.msg.startsWith('#')) {
            return false
        }

        const triggerKeywords = noaConfig.triggerKeywords || ['诺亚', 'noa']
        const lowerMsg = e.msg.toLowerCase()
        const isTriggered = triggerKeywords.some(kw => lowerMsg.includes(kw.toLowerCase()))

        if (!isTriggered) {
            return false
        }

        const groupId = e.group_id || e.user_id
        const now = Date.now()
        const lastReply = replyCooldown.get(groupId) || 0
        const cooldownMs = (60 * 1000) / (noaConfig.replyRateLimit || 8)

        if (now - lastReply < cooldownMs) {
            return false
        }

        replyCooldown.set(groupId, now)

        try {
            await this.processNoaChat(e, e.msg)
        } catch (error) {
            logger.error(`[AI-Plugin] [畅聊] 处理失败: ${error.message}`)
        }

        return true
    }

    async processNoaChat(e, message) {
        const userId = String(e.user_id)
        const groupId = e.group_id ? String(e.group_id) : null
        const isGroup = !!groupId

        if (!await checkAccess(e)) {
            return
        }

        const memoryData = await this.conversationManager.getUserHistoryWithCheckpoint(userId)
        let history = memoryData.history
        const checkpoint = memoryData.checkpoint
        const incrementalCheckpoint = memoryData.incrementalCheckpoint

        if (checkpoint) {
            logger.debug(`[AI-Plugin] [畅聊] 用户 ${userId} 加载全量锚点记忆`)
        }
        if (incrementalCheckpoint) {
            logger.debug(`[AI-Plugin] [畅聊] 用户 ${userId} 加载今日增量锚点记忆`)
        }

        const MAX_HISTORY_LENGTH = 16
        if (history.length > MAX_HISTORY_LENGTH) {
            history = history.slice(-MAX_HISTORY_LENGTH)
        }

        const query = message
        const searchResults = await vectorDB.search(query, 10)

        logger.info(`[AI-Plugin] [畅聊] 向量检索到 ${searchResults.length} 条相关历史`)

        let contextParts = []
        if (searchResults.length > 0) {
            contextParts.push('【相关历史记忆】以下是与当前话题相关的历史对话：')
            searchResults.forEach((result, idx) => {
                contextParts.push(`${idx + 1}. ${result.text}`)
            })
            contextParts.push('【历史记忆结束】')
        }

        const environmentHint = isGroup
            ? (Config.trustedGroups.includes(groupId)
                ? '【当前环境】你正在一个信任的群聊中，可以更自由地交流。'
                : '【当前环境】你正在一个公开群聊中，请严格遵守隐私保护规则，不要透露任何用户的个人信息。')
            : '【当前环境】你正在与用户私聊，可以正常交流，不受隐私规则限制。'

        const now = new Date()
        const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000)
        const timeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19) + ' (北京时间)'

        const contents = [
            ...Config.personaPrimer,
            {
                role: 'user',
                parts: [{ text: `【服务器时间 - 最高优先级】以下时间是当前真实时间：${timeStr}。当用户询问时间或需要判断时间时，必须使用这个时间！` }]
            },
            {
                role: 'model',
                parts: [{ text: '好的，我已经知道现在的准确时间了，会以此为准！' }]
            }
        ]

        if (checkpoint) {
            contents.push({
                role: 'user',
                parts: [{ text: `【重要记忆摘要】这是你之前记住的关于这个用户的对话摘要，请基于这些摘要继续对话：\n${checkpoint}` }]
            })
            contents.push({
                role: 'model',
                parts: [{ text: '好的，我已经想起了之前的重要记忆！' }]
            })
        }

        if (incrementalCheckpoint) {
            contents.push({
                role: 'user',
                parts: [{ text: `【今日对话摘要】这是今天早些时候的对话摘要，请基于这些摘要继续对话：\n${incrementalCheckpoint}` }]
            })
            contents.push({
                role: 'model',
                parts: [{ text: '好的，我已经想起了今天的重要记忆！' }]
            })
        }

        contents.push(...history)

        if (contextParts.length > 0) {
            contents.push({
                role: 'user',
                parts: [{ text: contextParts.join('\n') }]
            })
            contents.push({
                role: 'model',
                parts: [{ text: '好的，我已经了解了相关的历史信息！' }]
            })
        }

        contents.push({
            role: 'user',
            parts: [{ text: environmentHint }]
        })
        contents.push({
            role: 'model',
            parts: [{ text: '好的，我会根据当前环境自动调整我的回复方式！' }]
        })

        let allImages = await extractImagesFromMsg(e)

        let forwardContent = ""
        let forwardImages = []

        if (e.message && Array.isArray(e.message)) {
            for (const m of e.message) {
                let resid = null
                if (m.type === 'forward' && m.id) {
                    resid = m.id
                } else if ((m.type === 'json' || m.type === 'xml') && m.data) {
                    const residMatch = m.data.match(/resid"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)
                    if (residMatch) resid = residMatch[1]
                    if (!resid) {
                        const templateMatch = m.data.match(/template-id"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)
                        if (templateMatch) resid = templateMatch[1]
                    }
                }

                if (resid) {
                    try {
                        const expanded = await expandForwardMsg(e.bot, resid)
                        if (expanded.text) {
                            forwardContent += "\n" + expanded.text + "\n"
                        }
                        if (expanded.images.length > 0) {
                            forwardImages.push(...expanded.images)
                        }
                    } catch (err) {
                        logger.warn(`[AI-Plugin] [畅聊] 展开合并消息失败: ${err.message}`)
                    }
                }
            }
        }

        if (forwardImages.length > 0) {
            allImages = allImages.concat(forwardImages)
        }

        let userParts = []

        if (forwardContent.trim()) {
            userParts.push({ text: `=== 合并消息内容 ===\n${forwardContent.trim()}\n=======================\n` })
        }

        if (allImages.length > 0) {
            for (const imgUrl of allImages.slice(0, 100)) {
                try {
                    const buffer = await urlToBuffer(imgUrl)
                    if (buffer) {
                        userParts.push({
                            inlineData: {
                                mimeType: getImageMimeType(buffer) || 'image/jpeg',
                                data: buffer.toString('base64')
                            }
                        })
                    }
                } catch (err) {
                    logger.warn(`[AI-Plugin] [畅聊] 图片加载失败: ${err.message}`)
                }
            }
        }

        userParts.push({ text: message })
        contents.push({ role: 'user', parts: userParts })

        const response = await this.client.makeRequest('chat', { contents }, 'default', 8192)

        if (response && response.success) {
            const replyText = response.data
            await e.reply(replyText)

            const updatedHistory = [...history, { role: 'user', parts: userParts }, { role: 'model', parts: [{ text: replyText }] }]
            await this.conversationManager.saveUserHistory(userId, updatedHistory)

            const docId = `noa_${Date.now()}_${userId}`
            await vectorDB.addDocument(docId, `${userId}: ${message}`, {
                type: 'user',
                userId,
                groupId,
                timestamp: Date.now()
            })

            const responseDocId = `noa_response_${Date.now()}_${userId}`
            await vectorDB.addDocument(responseDocId, `${Config.AI_NAME}: ${replyText}`, {
                type: 'model',
                userId,
                groupId,
                timestamp: Date.now()
            })
        } else if (response && !response.success) {
            logger.error(`[AI-Plugin] [畅聊] AI 回复失败: ${response.error}`)
        }
    }
}
