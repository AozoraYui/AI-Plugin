import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import { Config } from '../utils/config.js'
import { GeminiClient } from '../client/GeminiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess, getAccessConfig, saveAccessConfig } from '../utils/access.js'
import { setMsgEmojiLike, takeSourceMsg, getAvatarUrl, urlToBuffer, getImageMimeType, getTodayDateStr } from '../utils/common.js'

async function expandForwardMsg(bot, resid, depth = 0, maxDepth = 5) {
    const textParts = []
    const images = []

    if (depth >= maxDepth) {
        return { text: '--- [嵌套层级过深，停止展开] ---', images: [] }
    }

    try {
        const res = await bot.sendApi('get_forward_msg', { message_id: resid })
        const details = res?.messages || res?.data?.messages || res

        if (!Array.isArray(details) || details.length === 0) {
            return { text: '', images: [] }
        }

        const indent = '  '.repeat(depth)
        textParts.push(`${indent}--- [已展开合并转发消息${depth > 0 ? ` (第${depth}层嵌套)` : ''}] ---`)

        for (const subMsg of details.slice(0, 100)) {
            const sender = subMsg.nickname || subMsg.sender?.nickname || "未知用户"
            const msgArray = subMsg.content || subMsg.message

            if (Array.isArray(msgArray)) {
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
                    } else if (seg.type === 'forward' && seg.id) {
                        const nested = await expandForwardMsg(bot, seg.id, depth + 1, maxDepth)
                        textParts.push(`${indent}  [${sender}] (嵌套消息):`)
                        textParts.push(nested.text)
                        images.push(...nested.images)
                    }
                }
                if (subText.trim()) {
                    textParts.push(`${indent}[${sender}]: ${subText}`)
                }
            } else if (typeof msgArray === 'string') {
                if (msgArray.trim()) {
                    textParts.push(`${indent}[${sender}]: ${msgArray}`)
                }
            }
        }

        textParts.push(`${indent}--- [合并转发结束] ---`)
    } catch (err) {
        logger.warn(`[AI-Plugin] 展开合并转发失败 (深度${depth}):`, err)
        return { text: `--- [展开失败: ${err.message}] ---`, images: [] }
    }

    return { text: textParts.join('\n'), images }
}

export class ChatHandler extends plugin {
    constructor() {
        super({
            name: 'AI对话',
            dsc: '与AI进行智能对话',
            event: 'message',
            priority: 1144,
            rule: [
                { reg: /^#([a-zA-Z0-9]*)(?:s|single)([a-zA-Z0-9]*)gm([\s\S]*)$/i, fnc: 'handleSingleChat' },
                { reg: /^#([a-zA-Z0-9]*)gm([\s\S]*)$/i, fnc: 'handleChat' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}记忆$`, 'i'), fnc: 'exportMyMemory' },
                { reg: new RegExp(`^#导出${Config.AI_NAME}全部记忆$`, 'i'), fnc: 'exportAllMemory', permission: 'master' },
                { reg: /^#gemini思考(开启|关闭)$/i, fnc: 'switchThinkingMode', permission: 'master' },
            ]
        })
        this.client = global.AIPluginClient
        this.conversationManager = global.AIPluginConversationManager
    }

    async handleSingleChat(e) {
        if (!await checkAccess(e)) return true

        const match = e.msg.match(/^#([a-zA-Z0-9]*)(?:s|single)([a-zA-Z0-9]*)gm([\s\S]*)/i)
        if (!match) return

        e._singleMode = true

        const prefix1 = match[1].toLowerCase()
        const prefix2 = match[2].toLowerCase()

        let modelPrefix = ''
        if (prefix1 === 'pro' || prefix1 === '3') modelPrefix = prefix1
        if (prefix2 === 'pro' || prefix2 === '3') modelPrefix = prefix2

        e.msg = `#${modelPrefix}gm${match[3]}`
        return this.handleChat(e)
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
                await e.reply(`${Config.AI_NAME}思考中 (使用 ${modelGroupKey} 模型组)…`, true)
            } else {
                await e.reply(`${Config.AI_NAME}思考中 (单次对话模式，使用 ${modelGroupKey} 模型组)…`, true)
            }
            await setMsgEmojiLike(e, 282)

            let history = []
            let checkpoint = null
            let incrementalCheckpoint = null

            if (!isSingleMode) {
                const memoryData = await this.conversationManager.getUserHistoryWithCheckpoint(userId)
                history = memoryData.history
                checkpoint = memoryData.checkpoint
                incrementalCheckpoint = memoryData.incrementalCheckpoint

                if (checkpoint) {
                    logger.debug(`[AI-Plugin] 用户 ${userId} 加载全量锚点记忆`)
                }
                if (incrementalCheckpoint) {
                    logger.debug(`[AI-Plugin] 用户 ${userId} 加载今日增量锚点记忆`)
                }

                // 防止请求体过大导致 413 错误，限制历史长度
                const MAX_HISTORY_LENGTH = 16
                if (history.length > MAX_HISTORY_LENGTH) {
                    history = history.slice(-MAX_HISTORY_LENGTH)
                    logger.debug(`[AI-Plugin] 用户 ${userId} 的历史过长，已截断至最近 ${MAX_HISTORY_LENGTH} 条`)
                }
            }

            const currentUserTurnParts = []

            // 限制图片数量和大小，防止请求体过大
            const MAX_IMAGES = 100
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

            // 添加当前服务器时间
            const now = new Date()
            const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000)
            const timeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19) + ' (北京时间)'
            contents.push({
                "role": "user",
                "parts": [{ "text": `【服务器时间】以下时间来自于当前运行本插件的服务器系统时间：${timeStr}。请基于这个时间信息来回答用户关于时间的问题。` }]
            })
            contents.push({
                "role": "model",
                "parts": [{ "text": "好的，我已经知道现在的时间了！" }]
            })

            if (checkpoint) {
                contents.push({
                    "role": "user",
                    "parts": [{ "text": `【重要记忆摘要】这是你之前记住的关于这个用户的对话摘要，请基于这些摘要继续对话：\n${checkpoint}` }]
                })
                contents.push({
                    "role": "model",
                    "parts": [{ "text": "好的，我已经想起了之前的重要记忆！" }]
                })
            }

            if (incrementalCheckpoint) {
                contents.push({
                    "role": "user",
                    "parts": [{ "text": `【今日对话摘要】这是今天早些时候的对话摘要，请基于这些摘要继续对话：\n${incrementalCheckpoint}` }]
                })
                contents.push({
                    "role": "model",
                    "parts": [{ "text": "好的，我已经想起了今天的重要记忆！" }]
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
                    if (checkpoint) {
                        contents.push({
                            "role": "user",
                            "parts": [{ "text": `【重要记忆摘要】这是你之前记住的关于这个用户的对话摘要，请基于这些摘要继续对话：\n${checkpoint}` }]
                        })
                        contents.push({
                            "role": "model",
                            "parts": [{ "text": "好的，我已经想起了之前的重要记忆！" }]
                        })
                    }
                    if (incrementalCheckpoint) {
                        contents.push({
                            "role": "user",
                            "parts": [{ "text": `【今日对话摘要】这是今天早些时候的对话摘要，请基于这些摘要继续对话：\n${incrementalCheckpoint}` }]
                        })
                        contents.push({
                            "role": "model",
                            "parts": [{ "text": "好的，我已经想起了今天的重要记忆！" }]
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

                // 非单次对话模式才保存历史记录
                if (!isSingleMode) {
                    const updatedHistory = [...history, { "role": "user", "parts": currentUserTurnParts }, { "role": "model", "parts": [{ "text": finalResponseText }] }]
                    await this.conversationManager.saveUserHistory(userId, updatedHistory)
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
