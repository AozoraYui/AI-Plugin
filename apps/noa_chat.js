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

        const query = message
        const searchResults = await vectorDB.search(query, 10)

        logger.info(`[AI-Plugin] [畅聊] 静默检索到 ${searchResults.length} 条相关历史`)

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
            },
            {
                role: 'user',
                parts: [{ text: environmentHint }]
            },
            {
                role: 'model',
                parts: [{ text: '好的，我会根据当前环境自动调整我的回复方式！' }]
            }
        ]

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

        const images = await extractImagesFromMsg(e)
        let userParts = []

        if (images.length > 0) {
            for (const imgUrl of images.slice(0, 100)) {
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

        const response = await this.client.generateContent(contents, {
            maxOutputTokens: 8192,
            temperature: 0.9,
            topP: 0.95
        })

        if (response) {
            await e.reply(response)

            await this.conversationManager.saveUserMessage(userId, message, images)
            await this.conversationManager.saveModelMessage(userId, response)

            const docId = `noa_${Date.now()}_${userId}`
            await vectorDB.addDocument(docId, `${userId}: ${message}`, {
                type: 'user',
                userId,
                groupId,
                timestamp: Date.now()
            })

            const responseDocId = `noa_response_${Date.now()}_${userId}`
            await vectorDB.addDocument(responseDocId, `${Config.AI_NAME}: ${response}`, {
                type: 'model',
                userId,
                groupId,
                timestamp: Date.now()
            })
        }
    }
}
