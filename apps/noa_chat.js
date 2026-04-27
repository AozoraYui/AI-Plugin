import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { GeminiClient } from '../client/GeminiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess } from '../utils/access.js'
import { expandForwardMsg } from './chat.js'
import { takeSourceMsg, getImageMimeType, urlToBuffer } from '../utils/common.js'
import { vectorDB } from '../utils/vector_db.js'

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

        // 检查是否有合并消息需要展开
        let hasForwardMsg = false
        if (e.message && Array.isArray(e.message)) {
            hasForwardMsg = e.message.some(m => m.type === 'forward' || ((m.type === 'json' || m.type === 'xml') && m.data?.match(/resid|template-id/)))
        }

        if (!e.msg && !hasForwardMsg) {
            return false
        }

        if (e.msg && e.msg.startsWith('#')) {
            return false
        }

        let messageContent = e.msg || ''
        let allImages = []

        const sourceMsg = await takeSourceMsg(e)
        if (sourceMsg && sourceMsg.message) {
            let replyText = ""
            let forwardContent = ""
            let forwardImages = []

            for (const m of sourceMsg.message) {
                let resid = null
                if (m.type === 'forward' && m.id) {
                    resid = m.id
                    logger.info(`[AI-Plugin] [畅聊] 发现引用中的嵌套合并消息 (type=forward, id=${resid})，开始递归展开`)
                } else if ((m.type === 'json' || m.type === 'xml') && m.data) {
                    const residMatch = m.data.match(/resid"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)
                    if (residMatch) {
                        resid = residMatch[1]
                        logger.info(`[AI-Plugin] [畅聊] 发现引用中的嵌套合并消息 (json/xml, resid=${resid})，开始递归展开`)
                    }
                    if (!resid) {
                        const templateMatch = m.data.match(/template-id"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)
                        if (templateMatch) {
                            resid = templateMatch[1]
                            logger.info(`[AI-Plugin] [畅聊] 发现引用中的嵌套合并消息 (json/xml, template-id=${resid})，开始递归展开`)
                        }
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
                        logger.warn(`[AI-Plugin] [畅聊] 展开引用中的合并消息失败: ${err.message}`)
                    }
                }

                if (m.type === 'text') {
                    replyText += m.text || ''
                } else if (m.type === 'image') {
                    const imgUrl = m.data?.url || m.url
                    if (imgUrl) {
                        allImages.push(imgUrl)
                    }
                }
            }

            if (forwardContent) {
                replyText += forwardContent
            }

            if (forwardImages.length > 0) {
                allImages = allImages.concat(forwardImages)
            }

            if (replyText.trim()) {
                const separator = "\n=== 引用/转发内容 ===\n"
                messageContent = `${messageContent}\n${separator}${replyText.trim()}\n=======================\n`
            }
        }

        if (e.message && Array.isArray(e.message)) {
            for (const m of e.message) {
                let resid = null
                if (m.type === 'forward' && m.id) {
                    resid = m.id
                    logger.info(`[AI-Plugin] [畅聊] 发现嵌套合并消息 (type=forward, id=${resid})，开始递归展开`)
                } else if ((m.type === 'json' || m.type === 'xml') && m.data) {
                    const residMatch = m.data.match(/resid"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)
                    if (residMatch) {
                        resid = residMatch[1]
                        logger.info(`[AI-Plugin] [畅聊] 发现嵌套合并消息 (json/xml, resid=${resid})，开始递归展开`)
                    }
                    if (!resid) {
                        const templateMatch = m.data.match(/template-id"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)
                        if (templateMatch) {
                            resid = templateMatch[1]
                            logger.info(`[AI-Plugin] [畅聊] 发现嵌套合并消息 (json/xml, template-id=${resid})，开始递归展开`)
                        }
                    }
                }

                if (resid) {
                    try {
                        const expanded = await expandForwardMsg(e.bot, resid)
                        if (expanded.text) {
                            messageContent = expanded.text
                            logger.info(`[AI-Plugin] [畅聊] 展开合并消息成功，内容长度: ${expanded.text.length}`)
                        }
                        if (expanded.images.length > 0) {
                            allImages = allImages.concat(expanded.images)
                        }
                    } catch (err) {
                        logger.warn(`[AI-Plugin] [畅聊] 展开合并消息失败: ${err.message}`)
                    }
                } else if (m.type === 'image') {
                    const imgUrl = m.data?.url || m.url
                    if (imgUrl) {
                        allImages.push(imgUrl)
                    }
                }
            }
        }

        const triggerKeywords = noaConfig.triggerKeywords || ['诺亚', 'noa']
        const lowerMsg = messageContent.toLowerCase()
        const isTriggered = hasForwardMsg || triggerKeywords.some(kw => lowerMsg.includes(kw.toLowerCase()))

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
            await this.processNoaChat(e, messageContent, allImages)
        } catch (error) {
            logger.error(`[AI-Plugin] [畅聊] 处理失败: ${error.message}`)
        }

        return true
    }

    async processNoaChat(e, message, allImages = []) {
        const userId = String(e.user_id)
        const groupId = e.group_id ? String(e.group_id) : null
        const isGroup = !!groupId

        if (!await checkAccess(e)) {
            return
        }

        let recentGroupChat = ""
        if (isGroup && e.group?.getChatHistory) {
            try {
                const recentMsgs = await e.group.getChatHistory(e.source?.seq || e.message_id, 10)
                if (recentMsgs && recentMsgs.length > 0) {
                    const chatLines = []
                    for (const msg of recentMsgs) {
                        if (msg.sender?.user_id === e.user_id) continue
                        const senderName = msg.sender?.nickname || msg.sender?.card || `用户${msg.sender?.user_id}`
                        let textContent = ""

                        if (msg.message && Array.isArray(msg.message)) {
                            for (const seg of msg.message) {
                                if (seg.type === 'text') {
                                    textContent += seg.data?.text || seg.text || ''
                                } else if (seg.type === 'image') {
                                    textContent += '[图片]'
                                } else if (seg.type === 'forward') {
                                    const resid = seg.data?.id || seg.id
                                    if (resid) {
                                        try {
                                            const expanded = await expandForwardMsg(e.bot, resid)
                                            if (expanded.text) {
                                                textContent += `\n[合并消息内容]\n${expanded.text}\n`
                                            }
                                        } catch (err) {
                                            textContent += '[合并转发消息]'
                                        }
                                    }
                                } else if ((seg.type === 'json' || seg.type === 'xml') && seg.data) {
                                    const residMatch = seg.data?.match(/resid"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)
                                    if (residMatch) {
                                        try {
                                            const expanded = await expandForwardMsg(e.bot, residMatch[1])
                                            if (expanded.text) {
                                                textContent += `\n[合并消息内容]\n${expanded.text}\n`
                                            }
                                        } catch (err) {
                                            textContent += '[合并转发消息]'
                                        }
                                    }
                                }
                            }
                        }

                        if (textContent.trim()) {
                            chatLines.push(`[${senderName}]: ${textContent.trim()}`)
                        }
                    }
                    if (chatLines.length > 0) {
                        recentGroupChat = chatLines.join('\n')
                        logger.info(`[AI-Plugin] [畅聊] 加载最近 ${chatLines.length} 条群聊历史`)
                    }
                }
            } catch (err) {
                logger.warn(`[AI-Plugin] [畅聊] 获取群聊历史失败: ${err.message}`)
            }
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
            contextParts.push('【相关历史记忆】以下是与当前话题相关的历史对话（括号内为消息发生的时间）：')
            searchResults.forEach((result, idx) => {
                const ts = result.metadata?.timestamp
                const timeStr = ts ? new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知时间'
                contextParts.push(`${idx + 1}. [${timeStr}] ${result.text}`)
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

        if (recentGroupChat) {
            contents.push({
                role: 'user',
                parts: [{ text: `【最近群聊上下文】以下是当前群聊中最近的对话，帮助你了解上下文：\n${recentGroupChat}\n【群聊上下文结束】` }]
            })
            contents.push({
                role: 'model',
                parts: [{ text: '好的，我已经了解了当前群聊的最近对话！' }]
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

        let userParts = []

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
