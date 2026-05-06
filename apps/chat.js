import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { Config, expandPrompt } from '../utils/config.js'
import { AiClient } from '../client/AiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess, getAccessConfig, saveAccessConfig } from '../utils/access.js'
import { setMsgEmojiLike, takeSourceMsg, getAvatarUrl, urlToBuffer, getImageMimeType, getBeijingTimeStr, getTodayDateStr, resolveModelGroup, resolveModelDisplay } from '../utils/common.js'

function extractCardInfo(data) {
    const lines = []
    const meta = data.meta || data.detail || data.appmsg || data.app || {}
    const news = meta.news || meta.detail || meta.appmsg || meta.app || {}
    const title = news.title || news.desc || data.prompt || ''
    const desc = news.desc || news.brief || news.summary || ''
    const source = news.source || news.tag || news.appname || data.app || ''
    const url = news.jumpUrl || news.url || news.link || ''
    if (title) lines.push(`标题: ${title}`)
    if (desc) lines.push(`描述: ${desc}`)
    if (source) lines.push(`来源: ${source}`)
    if (url) lines.push(`链接: ${url}`)
    if (lines.length === 0) {
        const fallbackFields = ['prompt', 'title', 'desc', 'content', 'summary', 'text', 'brief', 'source']
        for (const field of fallbackFields) {
            if (data[field] && typeof data[field] === 'string' && data[field].trim()) {
                lines.push(data[field].trim())
            }
        }
    }
    return lines.length > 0 ? lines.join('\n') : ''
}

async function expandForwardMsg(bot, resid, depth = 0, maxDepth = Config.FORWARD_MSG_MAX_DEPTH) {
    const textParts = []
    const images = []

    if (depth >= maxDepth) {
        return { text: '【嵌套层级过深，停止展开】', images: [] }
    }

    try {
        const res = await bot.sendApi('get_forward_msg', { message_id: resid })
        const details = res?.messages || res?.data?.messages || res

        if (!Array.isArray(details) || details.length === 0) {
            return { text: '', images: [] }
        }

        const layerTag = depth > 0 ? `第${depth}层` : ''
        textParts.push(`【合并转发消息${layerTag} 开始】`)

        for (const subMsg of details.slice(0, Config.FORWARD_MSG_MAX_COUNT)) {
            const sender = subMsg.nickname || subMsg.sender?.nickname || "未知用户"
            const msgArray = subMsg.content || subMsg.message

            if (Array.isArray(msgArray)) {
                const expanded = await expandInlineContent(bot, msgArray, sender, depth, maxDepth)
                textParts.push(expanded.text)
                images.push(...expanded.images)
            } else if (typeof msgArray === 'string') {
                if (msgArray.trim()) {
                    textParts.push(`[${sender}]: ${msgArray}`)
                }
            } else {
                logger.info(`[AI-Plugin] msgArray 类型异常: ${typeof msgArray}, 内容: ${JSON.stringify(msgArray).slice(0, 300)}`)
            }
        }

        textParts.push(`【合并转发消息${layerTag} 结束】`)
    } catch (err) {
        logger.warn(`[AI-Plugin] 展开合并转发失败 (深度${depth}):`, err)
        return { text: `【展开失败: ${err.message}】`, images: [] }
    }

    return { text: textParts.join('\n'), images }
}

async function expandInlineContent(bot, msgArray, sender = "发送者", depth = 0, maxDepth = Config.FORWARD_MSG_MAX_DEPTH) {
    const textParts = []
    const images = []

    if (depth >= maxDepth) {
        return { text: '【嵌套层级过深，停止展开】', images: [] }
    }

    let subText = ""
    for (const seg of msgArray) {
        if (seg.type === 'text') {
            subText += seg.data?.text || seg.text || ''
        } else if (seg.type === 'image') {
            const imgUrl = seg.data?.url || seg.url
            if (imgUrl) {
                images.push(imgUrl)
                subText += " [图片] "
            }
        } else if (seg.type === 'forward') {
            const nestedId = seg.id || seg.data?.id
            const nestedContent = seg.data?.content || seg.content
            if (Array.isArray(nestedContent)) {
                logger.info(`[AI-Plugin] 发现内联合并消息 (type=forward, 内联content)，开始递归展开 (深度${depth + 1})`)
                const layerTag = `第${depth + 1}层`
                textParts.push(`【${layerTag}嵌套消息 开始】`)
                for (const nestedMsg of nestedContent) {
                    const nestedSender = nestedMsg.nickname || nestedMsg.sender?.nickname || "未知用户"
                    const nestedMsgArray = nestedMsg.content || nestedMsg.message
                    if (Array.isArray(nestedMsgArray)) {
                        const nested = await expandInlineContent(bot, nestedMsgArray, nestedSender, depth + 1, maxDepth)
                        textParts.push(nested.text)
                        images.push(...nested.images)
                    }
                }
                textParts.push(`【${layerTag}嵌套消息 结束】`)
                if (subText.trim()) {
                    textParts.push(`[${sender}]: ${subText}`)
                    subText = ""
                }
            } else if (nestedId) {
                logger.info(`[AI-Plugin] 发现嵌套合并消息 (type=forward, id=${nestedId})，开始递归展开 (深度${depth + 1})`)
                const nested = await expandForwardMsg(bot, nestedId, depth + 1, maxDepth)
                if (subText.trim()) {
                    textParts.push(`[${sender}]: ${subText}`)
                    subText = ""
                }
                textParts.push(nested.text)
                images.push(...nested.images)
            }
        } else if ((seg.type === 'json' || seg.type === 'xml') && seg.data) {
            let cardData = seg.data
            if (typeof cardData === 'object' && typeof cardData.data === 'string') {
                try {
                    cardData = JSON.parse(cardData.data)
                } catch (err) {
                    logger.warn(`[AI-Plugin] expandInlineContent JSON data 解析失败:`, err)
                }
            }
            if (typeof cardData === 'string') {
                const residMatch = cardData.match(/resid"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)
                if (residMatch) {
                    const nestedResid = residMatch[1]
                    logger.info(`[AI-Plugin] 从 JSON/XML 中发现嵌套 resid: ${nestedResid}，开始递归展开 (深度${depth + 1})`)
                    const nested = await expandForwardMsg(bot, nestedResid, depth + 1, maxDepth)
                    if (subText.trim()) {
                        textParts.push(`[${sender}]: ${subText}`)
                        subText = ""
                    }
                    textParts.push(nested.text)
                    images.push(...nested.images)
                }
            } else if (typeof cardData === 'object') {
                const cardInfo = extractCardInfo(cardData)
                if (cardInfo) {
                    subText += `\n[卡片消息]\n${cardInfo}\n`
                }
            }
        } else {
            logger.info(`[AI-Plugin] 消息段类型: ${seg.type}, 内容预览: ${JSON.stringify(seg).slice(0, 300)}`)
        }
    }

    if (subText.trim()) {
        textParts.push(`[${sender}]: ${subText}`)
    }

    return { text: textParts.join('\n'), images }
}

export class ChatHandler extends plugin {
    constructor() {
        super({
            name: 'AI对话',
            dsc: '与AI进行智能对话',
            event: 'message',
            priority: -9101,
            rule: [
                { reg: /^#([a-zA-Z0-9]*)s([a-zA-Z0-9]*)chat([\s\S]*)$/i, fnc: 'handleSingleChat' },
                { reg: /^#([a-zA-Z0-9]*)chat([\s\S]*)$/i, fnc: 'handleChat' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}记忆$`, 'i'), fnc: 'exportMyMemory' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}记忆\\s+(\\d{4}-\\d{2}-\\d{2})$`, 'i'), fnc: 'exportMemoryByDate' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}全部记忆$`, 'i'), fnc: 'exportAllMemory', permission: 'master' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}全部记忆\\s+(\\d{4}-\\d{2}-\\d{2})$`, 'i'), fnc: 'exportAllMemoryByDate', permission: 'master' },
                { reg: /^#ai思考(开启|关闭)$/i, fnc: 'switchThinkingMode', permission: 'master' },
            ]
        })
        this.client = global.AIPluginClient
        this.conversationManager = global.AIPluginConversationManager
    }

    async handleSingleChat(e) {
        if (!await checkAccess(e)) return true

        const match = e.msg.match(/^#([a-zA-Z0-9]*)s([a-zA-Z0-9]*)chat([\s\S]*)/i)
        if (!match) return

        e._singleMode = true

        const prefix1 = match[1].toLowerCase()
        const prefix2 = match[2].toLowerCase()

        let modelPrefix = ''
        if (resolveModelGroup(prefix1) !== 'flash') modelPrefix = prefix1
        if (resolveModelGroup(prefix2) !== 'flash') modelPrefix = prefix2

        e.msg = `#${modelPrefix}chat${match[3]}`
        return this.handleChat(e)
    }

    async handleChat(e) {
        if (!await checkAccess(e)) return true

        const match = e.msg.match(/^#([a-zA-Z0-9]*)chat([\s\S]*)/i)
        if (!match) return

        const prefix = match[1].toLowerCase()
        let userMessage = match[2].trim()

        const modelGroupKey = resolveModelGroup(prefix)
        const modelDisplay = resolveModelDisplay(modelGroupKey)

        const startTime = Date.now()
        let allImages = []

        try {
            const sourceMsg = await takeSourceMsg(e)

            if (sourceMsg) {
                if (sourceMsg.message) {
                    let replyText = ""
                    let forwardContent = ""
                    let forwardImages = []

                    for (const m of sourceMsg.message) {
                        let resid = null
                        if (m.type === 'forward' && m.id) {
                            const forwardContentArr = m.content || m.data?.content
                            if (Array.isArray(forwardContentArr)) {
                                logger.info(`[AI-Plugin] sourceMsg 中发现内联合并消息 (type=forward, 内联content)，开始递归展开`)
                                for (const nestedMsg of forwardContentArr) {
                                    const nestedSender = nestedMsg.nickname || nestedMsg.sender?.nickname || "未知用户"
                                    const nestedMsgArray = nestedMsg.content || nestedMsg.message
                                    if (Array.isArray(nestedMsgArray)) {
                                        const nested = await expandInlineContent(e.bot, nestedMsgArray, nestedSender)
                                        if (nested.text) {
                                            replyText += "\n" + nested.text + "\n"
                                        }
                                        forwardImages.push(...nested.images)
                                    }
                                }
                            } else {
                                resid = m.id
                            }
                        } else if ((m.type === 'json' || m.type === 'xml') && m.data) {
                            let cardData = m.data
                            if (typeof cardData === 'string') {
                                try {
                                    cardData = JSON.parse(cardData)
                                } catch (err) {
                                    logger.warn(`[AI-Plugin] JSON/XML data 解析失败:`, err)
                                }
                            }
                            if (typeof cardData === 'object') {
                                const residMatch = cardData.resid || (typeof m.data === 'string' && m.data.match(/resid"?\s*:\s*"?([a-zA-Z0-9_\-]+)"?/)?.[1])
                                if (residMatch) {
                                    resid = typeof residMatch === 'string' ? residMatch : residMatch[1]
                                }
                                if (!resid) {
                                    const cardInfo = extractCardInfo(cardData)
                                    if (cardInfo) {
                                        replyText += `\n[卡片消息]\n${cardInfo}\n`
                                    }
                                }
                            }
                        }

                        if (resid) {
                            const expanded = await expandForwardMsg(e.bot, resid)
                            if (expanded.text) {
                                forwardContent += "\n" + expanded.text + "\n"
                            }
                            if (expanded.images.length > 0) {
                                forwardImages.push(...expanded.images)
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
                        if (!userMessage) {
                            userMessage = replyText.trim()
                        } else {
                            userMessage = `${userMessage}\n${separator}${replyText.trim()}\n=======================\n`
                        }
                    }
                }
            }

            const currentImages = e.message.filter(m => m.type === "image").map(m => m.data?.url || m.url).filter(url => url)
            if (currentImages.length > 0) allImages = allImages.concat(currentImages)

            if (!userMessage && allImages.length === 0) return e.reply('请输入内容或发送图片呀', true)

            const isSingleMode = e._singleMode === true
            const userId = e.user_id

            if (!isSingleMode) {
                await e.reply(`${Config.AI_NAME}思考中 (使用 ${modelDisplay} 模型组)…`, true)
            } else {
                await e.reply(`${Config.AI_NAME}思考中 (单次对话模式，使用 ${modelDisplay} 模型组)…`, true)
            }
            await setMsgEmojiLike(e, 282)

            let history = []
            let incrementalCheckpoint = null

            if (!isSingleMode) {
                const memoryData = await this.conversationManager.getUserHistoryWithCheckpoint(userId)
                history = memoryData.history
                incrementalCheckpoint = memoryData.incrementalCheckpoint

                if (incrementalCheckpoint) {
                    logger.debug(`[AI-Plugin] 用户 ${userId} 加载增量总结记忆`)
                }

                const MAX_HISTORY_LENGTH = Config.MAX_HISTORY_LENGTH
                if (history.length > MAX_HISTORY_LENGTH) {
                    history = history.slice(-MAX_HISTORY_LENGTH)
                    logger.debug(`[AI-Plugin] 用户 ${userId} 的历史过长，已截断至最近 ${MAX_HISTORY_LENGTH} 条`)
                }
            }

            const currentUserTurnParts = []

            // 限制图片数量和大小，防止请求体过大
            const MAX_IMAGES = Config.MAX_IMAGES_PER_MESSAGE
            const MAX_IMAGE_SIZE_MB = Config.MAX_IMAGE_SIZE_MB
            if (allImages.length > 0) {
                const imagesToProcess = allImages.slice(0, MAX_IMAGES)

                const imagePromises = imagesToProcess.map(async (imageUrl) => {
                    try {
                        let imageBuffer = await urlToBuffer(imageUrl)
                        if (!imageBuffer) {
                            logger.warn(`[AI-Plugin] 获取图片失败: ${imageUrl}`)
                            return null
                        }

                        // 检查图片大小，超过限制则压缩
                        const sizeMB = imageBuffer.length / (1024 * 1024)
                        if (sizeMB > MAX_IMAGE_SIZE_MB) {
                            logger.warn(`[AI-Plugin] 图片过大 (${sizeMB.toFixed(2)}MB)，正在压缩...`)
                            const sharp = (await import('sharp')).default
                            imageBuffer = await sharp(imageBuffer)
                                .resize(Config.MAX_IMAGE_RESIZE, Config.MAX_IMAGE_RESIZE, { fit: 'inside', withoutEnlargement: true })
                                .jpeg({ quality: Config.IMAGE_QUALITY })
                                .toBuffer()
                        }

                        let mimeType = getImageMimeType(imageBuffer)
                        let finalBuffer = imageBuffer

                        if (mimeType === 'image/gif') {
                            finalBuffer = await (await import('sharp')).default(imageBuffer).toFormat('png').toBuffer()
                            mimeType = 'image/png'
                        }

                        return {
                            "inline_data": {
                                "mime_type": mimeType || 'image/jpeg',
                                "data": finalBuffer.toString('base64')
                            }
                        }
                    } catch (err) {
                        logger.warn(`[AI-Plugin] 图片处理异常: ${err.message}`)
                        return null
                    }
                })

                const processedImages = await Promise.all(imagePromises)
                const validImages = processedImages.filter(img => img !== null)
                
                if (validImages.length < allImages.length) {
                    const failedCount = allImages.length - validImages.length
                    logger.warn(`[AI-Plugin] ${failedCount} 张图片处理失败`)
                }
                
                currentUserTurnParts.push(...validImages)
            }

            if (userMessage) {
                currentUserTurnParts.push({ "text": userMessage })
            }

            let contents = [...Config.personaPrimer]

            // 添加当前服务器时间（放在最前面，确保不被旧记忆干扰）
            const timeStr = getBeijingTimeStr()
            contents.push({
                "role": "user",
                "parts": [{ "text": `【服务器时间 - 最高优先级】以下时间是当前真实时间，请忽略记忆中的任何旧时间信息：${timeStr}。当用户询问时间或需要判断时间时，必须使用这个时间！` }]
            })
            contents.push({
                "role": "model",
                "parts": [{ "text": "好的，我已经知道现在的准确时间了，会以此为准！" }]
            })

            if (incrementalCheckpoint) {
                contents.push({
                    "role": "user",
                    "parts": [{ "text": `【记忆总结】这是关于你与用户之前对话的记忆总结，包含了重要的上下文信息，请基于这些记忆继续对话：\n${incrementalCheckpoint}` }]
                })
                contents.push({
                    "role": "model",
                    "parts": [{ "text": "好的，我已经想起了之前的记忆！" }]
                })
            }

            contents.push(...history)

            // 添加聊天环境提示（放在历史之后，用户消息之前，确保最高优先级）
            const trustedGroups = Config.trustedGroups
            const prompts = Config.Prompts
            let environmentHint = ""
            if (e.isGroup) {
                const groupId = String(e.group_id)
                if (trustedGroups.includes(groupId)) {
                    environmentHint = expandPrompt(prompts?.environment?.trusted_group, { group_id: groupId }) || `【当前聊天环境】这是一个受信任的群聊环境（群号：${groupId}）。你可以正常交流，但仍需遵守基本的隐私保护规则。`
                } else {
                    environmentHint = expandPrompt(prompts?.environment?.public_group, { group_id: groupId }) || `【当前聊天环境】这是一个公开的 QQ 群聊（群号：${groupId}），属于公开场合。请严格遵守隐私保护规则，不要在与用户相关的对话中透露任何个人信息或敏感内容。`
                }
            } else {
                environmentHint = prompts?.environment?.private_chat || `【当前聊天环境】这是与用户的私聊对话，属于安全环境。可以正常交流。`
            }
            logger.info(`[AI-Plugin] 环境提示: ${environmentHint}`)
            contents.push({
                "role": "user",
                "parts": [{ "text": environmentHint }]
            })
            contents.push({
                "role": "model",
                "parts": [{ "text": "好的，我已经了解当前的聊天环境，会根据环境调整我的行为！" }]
            })

            contents.push({ "role": "user", "parts": currentUserTurnParts })

            // 估算请求体大小，防止 413 错误
            let currentPayload = { "contents": contents }
            let currentSizeMB = JSON.stringify(currentPayload).length / (1024 * 1024)
            
            if (currentSizeMB > Config.REQUEST_SIZE_WARNING_MB) { // 警告阈值
                logger.warn(`[AI-Plugin] 请求体过大 (${currentSizeMB.toFixed(2)}MB)，正在裁剪历史...`)
                // 减少历史条目直到大小合理
                while (currentSizeMB > Config.REQUEST_SIZE_LIMIT_MB && history.length > Config.MIN_HISTORY_FOR_TRUNCATION) {
                    history = history.slice(-Math.max(Config.MIN_HISTORY_FOR_TRUNCATION, history.length - 5))
                    contents = [...Config.personaPrimer]
                    contents.push({
                        "role": "user",
                        "parts": [{ "text": `【服务器时间 - 最高优先级】以下时间是当前真实时间，请忽略记忆中的任何旧时间信息：${timeStr}。当用户询问时间或需要判断时间时，必须使用这个时间！` }]
                    })
                    contents.push({
                        "role": "model",
                        "parts": [{ "text": "好的，我已经知道现在的准确时间了，会以此为准！" }]
                    })
                    if (incrementalCheckpoint) {
                        contents.push({
                            "role": "user",
                            "parts": [{ "text": `【记忆总结】这是关于你与用户之前对话的记忆总结，包含了重要的上下文信息，请基于这些记忆继续对话：\n${incrementalCheckpoint}` }]
                        })
                        contents.push({
                            "role": "model",
                            "parts": [{ "text": "好的，我已经想起了之前的记忆！" }]
                        })
                    }
                    contents.push(...history)
                    contents.push({
                        "role": "user",
                        "parts": [{ "text": environmentHint }]
                    })
                    contents.push({
                        "role": "model",
                        "parts": [{ "text": "好的，我已经了解当前的聊天环境，会根据环境调整我的行为！" }]
                    })
                    contents.push({ "role": "user", "parts": currentUserTurnParts })
                    currentPayload = { "contents": contents }
                    currentSizeMB = JSON.stringify(currentPayload).length / (1024 * 1024)
                }
                logger.info(`[AI-Plugin] 请求体已裁剪至 ${currentSizeMB.toFixed(2)}MB`)
            }
            
            const result = await this.client.makeRequest('chat', currentPayload, modelGroupKey)

            if (result.success) {
                let rawResponseText = result.data.trim()
                let finalResponseText = rawResponseText
                const config = getAccessConfig()
                if (!config.show_thinking) {
                    const blocks = rawResponseText.split('\n\n')
                    let startContentIndex = 0
                    let foundContent = false
                    for (let i = 0; i < blocks.length; i++) {
                        const currentBlock = blocks[i].trim()
                        const isThinkingBlock = currentBlock.startsWith('*Thinking') || currentBlock.startsWith('>')
                        if (!isThinkingBlock) {
                            startContentIndex = i
                            foundContent = true
                            break
                        }
                    }
                    if (foundContent) {
                        finalResponseText = blocks.slice(startContentIndex).join('\n\n').trim()
                        finalResponseText = finalResponseText.replace(/^>\s*/, '').trim()
                    }
                    if (!finalResponseText) {
                        finalResponseText = rawResponseText
                    }
                }
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

                let tokenInfo = ''
                if (result.usage) {
                    if (result.usage.prompt_tokens !== undefined && result.usage.completion_tokens !== undefined) {
                        tokenInfo = ` | 输入Tokens: ${result.usage.prompt_tokens} | 输出Tokens: ${result.usage.completion_tokens}`
                    } else if (result.usage.total_tokens) {
                        tokenInfo = ` | 消耗Token: ${result.usage.total_tokens}`
                    }
                }

                // 分段处理：如果回复内容过长，使用合并消息发送
                const MAX_LENGTH = Config.CHECKPOINT_DISPLAY_MAX_LENGTH
                const footerSuffix = isSingleMode ? ' (单次对话)' : ''
                const footerInfo = `⏱️ 耗时: ${elapsed}s${tokenInfo} @${result.platform}${footerSuffix}`

                if (finalResponseText.length <= MAX_LENGTH) {
                    await e.reply(`${finalResponseText}\n\n${footerInfo}`, true)
                } else {
                    const forwardMsgNodes = []
                    let content = finalResponseText
                    let part = 1

                    // 第一段包含回复内容
                    while (content.length > 0) {
                        let splitIndex = MAX_LENGTH
                        if (content.length > MAX_LENGTH) {
                            const lastNewLine = content.lastIndexOf('\n', MAX_LENGTH)
                            if (lastNewLine > MAX_LENGTH * 0.8) splitIndex = lastNewLine + 1
                        }
                        const chunk = content.slice(0, splitIndex)
                        content = content.slice(splitIndex)

                        if (content.length === 0) {
                            // 最后一段，加上耗时信息
                            forwardMsgNodes.push({
                                user_id: Bot.uin,
                                nickname: `${Config.AI_NAME} (Part ${part})`,
                                message: `${chunk}\n\n${footerInfo}`
                            })
                        } else {
                            forwardMsgNodes.push({
                                user_id: Bot.uin,
                                nickname: `${Config.AI_NAME} (Part ${part})`,
                                message: chunk
                            })
                        }
                        part++
                    }

                    const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
                    await e.reply(forwardMsg)
                }

                await setMsgEmojiLike(e, 144)

                if (!isSingleMode) {
                    const updatedHistory = [...history, { "role": "user", "parts": currentUserTurnParts }, { "role": "model", "parts": [{ "text": finalResponseText }] }]
                    await this.conversationManager.saveUserHistory(userId, updatedHistory)

                    const AUTO_SUMMARY_THRESHOLD = 8
                    if (updatedHistory.length >= AUTO_SUMMARY_THRESHOLD) {
                        logger.info(`[AI-Plugin] 用户 ${userId} 对话已达 ${updatedHistory.length} 轮，自动触发增量总结`)
                        const todayStr = getTodayDateStr()
                        try {
                            await this.conversationManager.createIncrementalCheckpoint(userId, todayStr, 0, modelGroupKey)
                            const KEEP_AFTER_SUMMARY = 0
                            const trimmedHistory = updatedHistory.slice(-KEEP_AFTER_SUMMARY)
                            await this.conversationManager.saveUserHistory(userId, trimmedHistory)
                            logger.info(`[AI-Plugin] 用户 ${userId} 增量总结完成，历史已清空`)
                        } catch (summaryErr) {
                            logger.error(`[AI-Plugin] 自动增量总结失败:`, summaryErr)
                        }
                    }
                }
            } else {
                await setMsgEmojiLike(e, 10)
                await e.reply(`❌ 请求失败\n错误: ${result.error}`, true)
            }
        } catch (err) {
            await setMsgEmojiLike(e, 10)
            logger.error(`[AI-Plugin] 对话处理异常:`, err)
            await e.reply(`❌ 处理异常: ${err.message}`, true)
        }
    }

    async exportMyMemory(e) {
        await e.reply("收到指令，正在打包你的专属记忆… 请稍等片刻喵~ ⏳")
        try {
            const userId = String(e.user_id)
            const result = await this.conversationManager.exportMemory(e, userId, 'single')
            if (result.success) {
                await this._sendMemoryFile(e, result.filePath, '你的专属记忆')
            } else {
                await e.reply(`❌ 导出失败: ${result.message}`, true)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 导出个人记忆失败:`, err)
            await e.reply(`❌ 导出失败了，呜呜呜…\n错误信息：${err.message}`, true)
        }
    }

    async exportMemoryByDate(e) {
        const dateMatch = e.msg.match(new RegExp(`^#导出${Config.AI_NAME}记忆\\s+(\\d{4}-\\d{2}-\\d{2})$`, 'i'))
        const targetDate = dateMatch[1]
        await e.reply(`收到指令，正在打包 ${targetDate} 的记忆… 请稍等片刻喵~ ⏳`)
        try {
            const userId = String(e.user_id)
            const result = await this.conversationManager.exportMemory(e, userId, 'single', targetDate)
            if (result.success) {
                await this._sendMemoryFile(e, result.filePath, `${targetDate} 的记忆`)
            } else {
                await e.reply(`❌ 导出失败: ${result.message}`, true)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 导出指定日期记忆失败:`, err)
            await e.reply(`❌ 导出失败了，呜呜呜…\n错误信息：${err.message}`, true)
        }
    }

    async exportAllMemory(e) {
        await e.reply(`收到最高权限指令，开始导出${Config.AI_NAME}的全部记忆… 这可能需要一点时间喵~ ⏳`)
        try {
            const result = await this.conversationManager.exportMemory(e, null, 'all')
            if (result.success) {
                await this._sendMemoryFile(e, result.filePath, '全部记忆')
            } else {
                await e.reply(`❌ 导出失败: ${result.message}`, true)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 导出全部记忆失败:`, err)
            await e.reply(`❌ 导出失败了，呜呜呜…\n错误信息：${err.message}`, true)
        }
    }

    async exportAllMemoryByDate(e) {
        const dateMatch = e.msg.match(new RegExp(`^#导出${Config.AI_NAME}全部记忆\\s+(\\d{4}-\\d{2}-\\d{2})$`, 'i'))
        const targetDate = dateMatch[1]
        await e.reply(`收到最高权限指令，开始导出 ${targetDate} 的全部记忆… 这可能需要一点时间喵~ ⏳`)
        try {
            const result = await this.conversationManager.exportMemory(e, null, 'all', targetDate)
            if (result.success) {
                await this._sendMemoryFile(e, result.filePath, `${targetDate} 的全部记忆`)
            } else {
                await e.reply(`❌ 导出失败: ${result.message}`, true)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 导出全部指定日期记忆失败:`, err)
            await e.reply(`❌ 导出失败了，呜呜呜…\n错误信息：${err.message}`, true)
        }
    }

    async _sendMemoryFile(e, filePath, memoryType) {
        if (e.isGroup) {
            try {
                await e.reply(`✅ 成功导出${memoryType}！正在上传到本群...`, true)
                await e.group.sendFile(filePath)
            } catch (uploadErr) {
                logger.error(`[AI-Plugin] 记忆文件群聊上传失败:`, uploadErr)
                await e.reply(`呜...文件上传失败了！\n但别担心，文件已经成功保存在服务器上了哦：\n${filePath}`, true)
            }
        } else {
            try {
                await e.reply(`✅ 成功导出${memoryType}！正在发送给你...`, true)
                await e.friend.sendFile(filePath)
            } catch (uploadErr) {
                logger.error(`[AI-Plugin] 记忆文件私聊发送失败:`, uploadErr)
                await e.reply(`呜...文件发送失败了！\n但别担心，文件已经成功保存在服务器上了哦：\n${filePath}`, true)
            }
        }
    }

    async switchThinkingMode(e) {
        const isTurnOn = e.msg.includes("开启")
        const config = getAccessConfig()

        config.show_thinking = isTurnOn
        saveAccessConfig(config)

        if (isTurnOn) {
            await e.reply("✅ 设置成功：已开启思考过程显示 (Raw模式)。")
        } else {
            await e.reply("🚫 设置成功：已关闭思考过程显示 (自动清洗模式)。")
        }
    }
}
