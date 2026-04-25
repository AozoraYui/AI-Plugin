import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { GeminiClient } from '../client/GeminiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess, getAccessConfig, saveAccessConfig } from '../utils/access.js'
import { sessionManager } from '../utils/session.js'
import { setMsgEmojiLike, takeSourceMsg, getAvatarUrl, urlToBuffer, getImageMimeType, parseModelGroup } from '../utils/common.js'

export class ChatHandler extends plugin {
    constructor(client, conversationManager) {
        super({
            name: 'AI对话',
            dsc: '与AI进行智能对话',
            event: 'message',
            priority: 1144,
            rule: [
                { reg: /^#([a-zA-Z0-9]*)gm([\s\S]*)$/i, fnc: 'handleChat' },
                { reg: /^#结束gemini对话$/i, fnc: 'resetChatHistory' },
                { reg: /^#记住我(.*)$/i, fnc: 'rememberMe' },
                { reg: /^#忘记我$/i, fnc: 'forgetMe' },
                { reg: /^#我(是|叫)谁$/i, fnc: 'whoAmI' },
                { reg: /^#导出诺亚记忆$/i, fnc: 'exportMyMemory' },
                { reg: /^#导出诺亚全部记忆$/i, fnc: 'exportAllMemory', permission: 'master' },
                { reg: /^#gemini思考(开启|关闭)$/i, fnc: 'switchThinkingMode', permission: 'master' },
            ]
        })
        this.client = client
        this.conversationManager = conversationManager
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
            let history = await this.conversationManager.getUserHistory(userId)
            const profile = this.conversationManager.getUserProfile(userId)

            let userContextPrimer = []
            if (profile && profile.info) {
                userContextPrimer.push(
                    { "role": "user", "parts": [{ "text": `【重要提醒】这是关于我的背景信息，请务必记住：${profile.info}` }] },
                    { "role": "model", "parts": [{ "text": "好的，诺亚记下了！" }] }
                )
            }

            const currentUserTurnParts = []

            const MAX_IMAGES = 32
            if (allImages.length > 0) {
                const imagesToProcess = allImages.slice(0, MAX_IMAGES)

                const imagePromises = imagesToProcess.map(async (imageUrl) => {
                    try {
                        let imageBuffer = await urlToBuffer(imageUrl)
                        if (!imageBuffer) {
                            logger.warn(`[AI-Plugin] 获取图片失败: ${imageUrl}`)
                            return null
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

            const payload = { "contents": [...Config.personaPrimer, ...userContextPrimer, ...history, { "role": "user", "parts": currentUserTurnParts }] }
            const result = await this.client.makeRequest('chat', payload, modelGroupKey)

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

                await e.reply(`${finalResponseText}\n\n⏱️ 耗时: ${elapsed}s${tokenInfo} @${result.platform}`, true)

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

    async resetChatHistory(e) {
        const success = await this.conversationManager.resetChatHistory(e.user_id)
        if (success) {
            await e.reply('✨ 你和诺亚的对话记忆已重置，可以开始新的话题啦！', true)
        } else {
            await e.reply('❌ 重置对话失败', true)
        }
    }

    async rememberMe(e) {
        const infoToRemember = e.msg.replace(/^#记住我/, '').trim()
        if (!infoToRemember) {
            return e.reply('你想让诺亚记住关于你的什么信息呀？', true)
        }

        const userId = e.user_id
        const prompt = `请将以下关于用户(QQ:${userId})的描述，提炼成一句简短的、用于自我介绍的第三人称陈述。例如，如果用户说"我叫青空由依，喜欢猫"，你应该提炼出"青空由依，一个喜欢猫咪的人"。请直接输出提炼后的陈述，不要加任何多余的话。用户描述：\n\n${infoToRemember}`

        try {
            const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] }
            const result = await this.client.makeRequest('chat', payload)

            if (result.success) {
                const summarizedInfo = result.data.trim()
                await this.conversationManager.saveUserProfile(userId, summarizedInfo)
                await e.reply(`好哒！诺亚记住啦！你是：${summarizedInfo}`, true)
            } else {
                throw new Error(result.error || "AI未能提炼信息")
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 记住我功能失败:`, err)
            await e.reply(`呜... 诺亚在记笔记的时候走神了... 稍后再试一次好不好？`, true)
        }
    }

    async forgetMe(e) {
        const deleted = await this.conversationManager.deleteUserProfile(e.user_id)
        if (deleted) {
            await e.reply('呜... 好吧... 诺亚已经把你从【长期记忆】里删除了... 有点舍不得呢...', true)
        } else {
            await e.reply('诶？诺亚的长期记忆里本来就没有你哦，所以不用忘记啦~', true)
        }
    }

    async whoAmI(e) {
        const profile = this.conversationManager.getUserProfile(e.user_id)
        if (profile && profile.info) {
            await e.reply(`我记得哦！你是${profile.info}！对不对呀？`, true)
        } else {
            await e.reply(`唔...诺亚的档案里还没有关于你的记录呢... 你可以试试用 #记住我 [关于你的信息] 来让诺亚记住你哦！`, true)
        }
    }

    async exportMyMemory(e) {
        const result = await this.conversationManager.exportMemory(e, e.user_id, 'single')
        if (result.success) {
            await e.reply(`✅ 记忆导出成功！文件已保存至: ${result.fileName}`, true)
        } else {
            await e.reply(`❌ 导出失败: ${result.message}`, true)
        }
    }

    async exportAllMemory(e) {
        await e.reply("收到最高权限指令，开始导出诺亚的全部记忆… 这可能需要一点时间喵~")
        const result = await this.conversationManager.exportMemory(e, null, 'all')
        if (result.success) {
            await e.reply(`✅ 全部记忆导出成功！文件已保存至: ${result.fileName}`, true)
        } else {
            await e.reply(`❌ 导出失败: ${result.message}`, true)
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
