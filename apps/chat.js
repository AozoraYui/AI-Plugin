import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { Config } from '../utils/config.js'
import { GeminiClient } from '../client/GeminiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess, getAccessConfig, saveAccessConfig } from '../utils/access.js'
import { setMsgEmojiLike, takeSourceMsg, getAvatarUrl, urlToBuffer, getImageMimeType, getTodayDateStr } from '../utils/common.js'

export class ChatHandler extends plugin {
    constructor() {
        super({
            name: 'AI对话',
            dsc: '与AI进行智能对话',
            event: 'message',
            priority: 1144,
            rule: [
                { reg: /^#(s|single)([a-zA-Z0-9]*)gm([\s\S]*)$/i, fnc: 'handleSingleChat' },
                { reg: /^#(?!(s|single))([a-zA-Z0-9]*)gm([\s\S]*)$/i, fnc: 'handleChat' },
                { reg: /^#结束gemini对话$/i, fnc: 'resetChatHistory' },
                { reg: /^#导出诺亚记忆$/i, fnc: 'exportMyMemory' },
                { reg: /^#导出诺亚全部记忆$/i, fnc: 'exportAllMemory', permission: 'master' },
                { reg: /^#gemini思考(开启|关闭)$/i, fnc: 'switchThinkingMode', permission: 'master' },
            ]
        })
        this.client = global.AIPluginClient
        this.conversationManager = global.AIPluginConversationManager
    }

    async handleChat(e) {
        if (!await checkAccess(e)) return true

        const match = e.msg.match(/^#([a-zA-Z0-9]*)gm([\s\S]*)/i)
        if (!match) return

        const prefix = match[1].toLowerCase()
        let userMessage = match[2].trim()

        let modelGroupKey = 'default'
        if (prefix === 'pro') modelGroupKey = 'pro'
        else if (prefix === '3') modelGroupKey = 'gemini3'

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
                                const res = await e.bot.sendApi('get_forward_msg', { message_id: resid })
                                const details = res?.messages || res?.data?.messages || res

                                if (Array.isArray(details) && details.length > 0) {
                                    forwardContent += "\n--- [已展开合并转发消息] ---\n"
                                    for (const subMsg of details.slice(0, 100)) {
                                        const sender = subMsg.nickname || subMsg.sender?.nickname || "未知用户"
                                        let subText = ""
                                        if (subMsg.message) {
                                            for (const seg of subMsg.message) {
                                                if (seg.type === 'text') {
                                                    subText += seg.data?.text || seg.text || ''
                                                } else if (seg.type === 'image') {
                                                    forwardImages.push(seg.url)
                                                }
                                            }
                                        }
                                        if (subText) {
                                            forwardContent += `[${sender}]: ${subText}\n`
                                        }
                                    }
                                }
                            } catch (err) {
                                logger.warn('[AI-Plugin] 展开合并转发失败:', err)
                            }
                        }

                        if (m.type === 'text') {
                            replyText += m.text || ''
                        } else if (m.type === 'image') {
                            allImages.push(m.url)
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

            const currentImages = e.message.filter(m => m.type === "image").map(m => m.url)
            if (currentImages.length > 0) allImages = allImages.concat(currentImages)

            if (!userMessage && allImages.length === 0) return e.reply('请输入内容或发送图片呀', true)

            await e.reply(`诺亚思考中 (使用 ${modelGroupKey} 模型组)…`, true)
            await setMsgEmojiLike(e, 282)

            const userId = e.user_id
            const memoryData = await this.conversationManager.getUserHistoryWithCheckpoint(userId)
            let history = memoryData.history

            if (memoryData.checkpoint) {
                logger.debug(`[AI-Plugin] 用户 ${userId} 加载全量锚点记忆`)
            }

            // 防止请求体过大导致 413 错误，限制历史长度
            const MAX_HISTORY_LENGTH = 32
            if (history.length > MAX_HISTORY_LENGTH) {
                history = history.slice(-MAX_HISTORY_LENGTH)
                logger.debug(`[AI-Plugin] 用户 ${userId} 的历史过长，已截断至最近 ${MAX_HISTORY_LENGTH} 条`)
            }

            const currentUserTurnParts = []

            // 限制图片数量和大小，防止请求体过大
            const MAX_IMAGES = 32
            const MAX_IMAGE_SIZE_MB = 4 // 单张图片最大 4MB
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
                                .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
                                .jpeg({ quality: 80 })
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
                currentUserTurnParts.push(...processedImages.filter(img => img !== null))
            }

            if (userMessage) {
                currentUserTurnParts.push({ "text": userMessage })
            }

            let contents = [...Config.personaPrimer]

            if (memoryData.checkpoint) {
                contents.push({
                    "role": "user",
                    "parts": [{ "text": `【重要记忆摘要】这是你之前记住的关于这个用户的对话摘要，请基于这些摘要继续对话：\n${memoryData.checkpoint}` }]
                })
                contents.push({
                    "role": "model",
                    "parts": [{ "text": "好的，我已经想起了之前的重要记忆！" }]
                })
            }

            contents.push(...history)
            contents.push({ "role": "user", "parts": currentUserTurnParts })

            const payload = { "contents": contents }
            
            // 估算请求体大小，防止 413 错误
            let currentPayload = { "contents": contents }
            let currentSizeMB = JSON.stringify(currentPayload).length / (1024 * 1024)
            
            if (currentSizeMB > 8) { // 8MB 警告阈值
                logger.warn(`[AI-Plugin] 请求体过大 (${currentSizeMB.toFixed(2)}MB)，正在裁剪历史...`)
                // 减少历史条目直到大小合理
                while (currentSizeMB > 5 && history.length > 5) {
                    history = history.slice(-Math.max(5, history.length - 5))
                    contents = [...Config.personaPrimer]
                    if (memoryData.checkpoint) {
                        contents.push({
                            "role": "user",
                            "parts": [{ "text": `【重要记忆摘要】这是你之前记住的关于这个用户的对话摘要，请基于这些摘要继续对话：\n${memoryData.checkpoint}` }]
                        })
                        contents.push({
                            "role": "model",
                            "parts": [{ "text": "好的，我已经想起了之前的重要记忆！" }]
                        })
                    }
                    contents.push(...history)
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
                const MAX_LENGTH = 3500
                const footerInfo = `⏱️ 耗时: ${elapsed}s${tokenInfo} @${result.platform}`

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
                                nickname: `诺亚 (Part ${part})`,
                                message: `${chunk}\n\n${footerInfo}`
                            })
                        } else {
                            forwardMsgNodes.push({
                                user_id: Bot.uin,
                                nickname: `诺亚 (Part ${part})`,
                                message: chunk
                            })
                        }
                        part++
                    }

                    const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
                    await e.reply(forwardMsg)
                }

                await setMsgEmojiLike(e, 144)
                const updatedHistory = [...history, { "role": "user", "parts": currentUserTurnParts }, { "role": "model", "parts": [{ "text": finalResponseText }] }]
                await this.conversationManager.saveUserHistory(userId, updatedHistory)
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

    async handleSingleChat(e) {
        if (!await checkAccess(e)) return true

        const match = e.msg.match(/^#(s|single)([a-zA-Z0-9]*)gm([\s\S]*)/i)
        if (!match) return

        const prefix = match[2].toLowerCase()
        let userMessage = match[3].trim()

        let modelGroupKey = 'default'
        if (prefix === 'pro') modelGroupKey = 'pro'
        else if (prefix === '3') modelGroupKey = 'gemini3'

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
                                const res = await e.bot.sendApi('get_forward_msg', { message_id: resid })
                                const details = res?.messages || res?.data?.messages || res

                                if (Array.isArray(details) && details.length > 0) {
                                    forwardContent += "\n--- [已展开合并转发消息] ---\n"
                                    for (const subMsg of details.slice(0, 100)) {
                                        const sender = subMsg.nickname || subMsg.sender?.nickname || "未知用户"
                                        let subText = ""
                                        if (subMsg.message) {
                                            for (const seg of subMsg.message) {
                                                if (seg.type === 'text') {
                                                    subText += seg.data?.text || seg.text || ''
                                                } else if (seg.type === 'image') {
                                                    forwardImages.push(seg.url)
                                                }
                                            }
                                        }
                                        if (subText) {
                                            forwardContent += `[${sender}]: ${subText}\n`
                                        }
                                    }
                                }
                            } catch (err) {
                                logger.warn('[AI-Plugin] 展开合并转发失败:', err)
                            }
                        }

                        if (m.type === 'text') {
                            replyText += m.text || ''
                        } else if (m.type === 'image') {
                            allImages.push(m.url)
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

            const currentImages = e.message.filter(m => m.type === "image").map(m => m.url)
            if (currentImages.length > 0) allImages = allImages.concat(currentImages)

            if (!userMessage && allImages.length === 0) return e.reply('请输入内容或发送图片呀', true)

            await e.reply(`诺亚思考中 (单次对话模式，使用 ${modelGroupKey} 模型组)…`, true)
            await setMsgEmojiLike(e, 282)

            const userId = e.user_id

            // 单次对话模式：不加载历史，只使用 personaPrimer
            let contents = [...Config.personaPrimer]

            const currentUserTurnParts = []

            // 限制图片数量和大小，防止请求体过大
            const MAX_IMAGES = 32
            const MAX_IMAGE_SIZE_MB = 4 // 单张图片最大 4MB
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
                                .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
                                .jpeg({ quality: 80 })
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
                currentUserTurnParts.push(...processedImages.filter(img => img !== null))
            }

            if (userMessage) {
                currentUserTurnParts.push({ "text": userMessage })
            }

            contents.push({ "role": "user", "parts": currentUserTurnParts })

            const payload = { "contents": contents }
            
            // 估算请求体大小，防止 413 错误
            let currentPayload = { "contents": contents }
            let currentSizeMB = JSON.stringify(currentPayload).length / (1024 * 1024)
            
            if (currentSizeMB > 8) { // 8MB 警告阈值
                logger.warn(`[AI-Plugin] 单次对话请求体过大 (${currentSizeMB.toFixed(2)}MB)`)
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
                const MAX_LENGTH = 3500
                const footerInfo = `⏱️ 耗时: ${elapsed}s${tokenInfo} @${result.platform} (单次对话)`

                if (finalResponseText.length <= MAX_LENGTH) {
                    await e.reply(`${finalResponseText}\n\n${footerInfo}`, true)
                } else {
                    const forwardMsgNodes = []
                    let content = finalResponseText
                    let part = 1

                    while (content.length > 0) {
                        let splitIndex = MAX_LENGTH
                        if (content.length > MAX_LENGTH) {
                            const lastNewLine = content.lastIndexOf('\n', MAX_LENGTH)
                            if (lastNewLine > MAX_LENGTH * 0.8) splitIndex = lastNewLine + 1
                        }
                        const chunk = content.slice(0, splitIndex)
                        content = content.slice(splitIndex)

                        if (content.length === 0) {
                            forwardMsgNodes.push({
                                user_id: Bot.uin,
                                nickname: `诺亚 (Part ${part})`,
                                message: `${chunk}\n\n${footerInfo}`
                            })
                        } else {
                            forwardMsgNodes.push({
                                user_id: Bot.uin,
                                nickname: `诺亚 (Part ${part})`,
                                message: chunk
                            })
                        }
                        part++
                    }

                    const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
                    await e.reply(forwardMsg)
                }

                await setMsgEmojiLike(e, 144)
                // 单次对话模式：不保存历史记录
            } else {
                await setMsgEmojiLike(e, 10)
                await e.reply(`❌ 请求失败\n错误: ${result.error}`, true)
            }
        } catch (err) {
            await setMsgEmojiLike(e, 10)
            logger.error(`[AI-Plugin] 单次对话处理异常:`, err)
            await e.reply(`❌ 处理异常: ${err.message}`, true)
        }
    }

    async resetChatHistory(e) {
        const success = await this.conversationManager.resetChatHistory(e.user_id)
        if (success) {
            await e.reply('✨ 你和诺亚的对话记忆已重置，可以开始新的话题啦！', true)
        } else {
            await e.reply('❌ 重置对话失败', true)
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

    async exportAllMemory(e) {
        await e.reply("收到最高权限指令，开始导出诺亚的全部记忆… 这可能需要一点时间喵~ ⏳")
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

    async _checkAndCreateAutoCheckpoint(userId) {
        const today = getTodayDateStr()
        
        // 检查今天是否已经创建过锚点
        const todayCheckpoint = await this.conversationManager.db.getCheckpoint(userId, today)
        if (todayCheckpoint) {
            logger.info(`[AI-Plugin] 用户 ${userId} 今天已创建过锚点，跳过`)
            return
        }
        
        try {
            logger.info(`[AI-Plugin] 用户 ${userId} 今天首次对话，自动创建增量锚点...`)
            await this.conversationManager.createIncrementalCheckpoint(userId, today, 0)
            logger.info(`[AI-Plugin] 用户 ${userId} 自动增量锚点创建成功`)
        } catch (err) {
            logger.error(`[AI-Plugin] 为用户 ${userId} 创建自动增量锚点失败:`, err)
        }
    }
}
