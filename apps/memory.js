import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'
import { Config } from '../utils/config.js'
import { GeminiClient } from '../client/GeminiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess } from '../utils/access.js'
import { sessionManager } from '../utils/session.js'
import { setMsgEmojiLike, getTodayDateStr } from '../utils/common.js'
import { SUMMARY_CACHE_DIR, CHECKPOINT_DIR } from '../utils/config.js'

export class MemoryHandler extends plugin {
    constructor(client, conversationManager) {
        super({
            name: 'AI记忆管理',
            dsc: '管理AI的记忆锚点和总结',
            event: 'message',
            priority: 1146,
            rule: [
                { reg: /^#([a-zA-Z0-9]*)gemini创建全量锚点$/i, fnc: "createFullCheckpoint" },
                { reg: /^#([a-zA-Z0-9]*)gemini创建增量锚点$/i, fnc: "createIncrementalCheckpoint" },
                { reg: /^#gemini总结记忆列表$/i, fnc: "listMemorySummaries" },
            ]
        })
        this.client = client
        this.conversationManager = conversationManager
    }

    async _getOrCreateDailySummary(dateDir, userId, rawJsonPath, modelGroupKey) {
        const cacheDir = path.join(SUMMARY_CACHE_DIR, dateDir)
        const cacheFile = path.join(cacheDir, `${userId}.txt`)

        if (fs.existsSync(cacheFile)) {
            logger.debug(`[AI-Plugin] 命中摘要缓存: ${dateDir}`)
            return fs.readFileSync(cacheFile, 'utf8')
        }

        if (!fs.existsSync(rawJsonPath)) return ""
        let dayContent = ""
        try {
            const history = JSON.parse(fs.readFileSync(rawJsonPath, 'utf8'))
            if (!Array.isArray(history)) return ""

            for (const turn of history) {
                const role = turn.role === 'user' ? '用户' : '诺亚'
                const text = turn.parts.map(p => p.text).join(' ')
                if (text) dayContent += `${role}: ${text}\n`
            }
        } catch (e) {
            return ""
        }

        if (!dayContent.trim()) return ""

        logger.info(`[AI-Plugin] 正在为 ${dateDir} 生成新摘要...`)
        const summaryPrompt = `
请将以下这段发生在【${dateDir}】的对话概括为一个简短的摘要（4096字以内）。
重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
直接输出摘要内容，不要加"好的"等客套话。
对话内容：
${dayContent}`

        const payload = { "contents": [{ "role": "user", "parts": [{ "text": summaryPrompt }] }] }
        const result = await this.client.makeRequest('chat', payload, modelGroupKey)

        if (result.success) {
            const summaryText = result.data.trim()
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
            fs.writeFileSync(cacheFile, summaryText, 'utf8')
            return `【${dateDir} 摘要】: ${summaryText}`
        } else {
            logger.warn(`[AI-Plugin] ${dateDir} 摘要生成失败: ${result.error}`)
            return `【${dateDir} 原始片段】: ${dayContent.slice(0, 500)}...`
        }
    }

    async _runCheckpointLogic(e, isFullRebuild) {
        if (!await checkAccess(e)) return true

        if (!fs.existsSync(SUMMARY_CACHE_DIR)) {
            fs.mkdirSync(SUMMARY_CACHE_DIR, { recursive: true })
        }
        if (!fs.existsSync(CHECKPOINT_DIR)) {
            fs.mkdirSync(CHECKPOINT_DIR, { recursive: true })
        }

        const userIdStr = String(e.user_id)
        const todayStr = getTodayDateStr()

        const prefixMatch = e.msg.match(/^#([a-zA-Z0-9]*)gemini/i)
        const prefix = prefixMatch ? (prefixMatch[1] || '').toLowerCase() : ''
        let modelGroupKey = 'default'
        if (prefix === 'pro') modelGroupKey = 'pro'
        else if (prefix === '3') modelGroupKey = 'gemini3'

        let modelDisplay = "Flash模型组"
        if (modelGroupKey === 'pro') modelDisplay = "Pro模型组"
        if (modelGroupKey === 'gemini3') modelDisplay = "Gemini 3模型组"

        let baseCheckpointDate = null
        let baseCheckpointContent = ""

        if (!isFullRebuild && fs.existsSync(CHECKPOINT_DIR)) {
            const files = fs.readdirSync(CHECKPOINT_DIR)
                .filter(name => name.startsWith(`${userIdStr}_`) && name.endsWith('.txt'))
                .sort()
                .reverse()

            if (files.length > 0) {
                const latestFile = files[0]
                const match = latestFile.match(/_(\d{4}-\d{2}-\d{2})\.txt$/)
                if (match) {
                    baseCheckpointDate = match[1]
                    if (baseCheckpointDate === todayStr) {
                        return e.reply("📅 今天已经创建过锚点啦！无需重复创建。\n如果想强制刷新，请使用 #gemini创建全量锚点")
                    }
                    baseCheckpointContent = fs.readFileSync(path.join(CHECKPOINT_DIR, latestFile), 'utf8')
                }
            }
        }

        let statusMsg = `📚 正在启动记忆归档 [${modelDisplay}]...`

        if (baseCheckpointDate) {
            statusMsg += `\n🔗 增量模式: 继承自锚点【${baseCheckpointDate}】\n将读取该存档 + 之后的新增记忆。`
        } else {
            statusMsg += isFullRebuild
                ? `\n🔥 全量模式 (强制重构): 忽略旧存档，正在回溯所有历史流水账...`
                : `\n🌱 增量模式 (初始化): 未发现旧存档，将从头开始创建第一个锚点。`
        }
        await e.reply(statusMsg, true)

        const startTime = Date.now()
        let finalContext = ""
        let processedDays = 0

        try {
            if (baseCheckpointDate && baseCheckpointContent) {
                finalContext += `\n=== 📜 【核心记忆存档 (截止于 ${baseCheckpointDate})】 ===\n${baseCheckpointContent}\n`
            }

            const HISTORY_DIR = path.join(process.cwd(), 'data', 'ai_assistant', 'user_histories')
            if (fs.existsSync(HISTORY_DIR)) {
                let dateDirs = fs.readdirSync(HISTORY_DIR)
                    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(path.join(HISTORY_DIR, name)).isDirectory())
                    .sort()

                if (baseCheckpointDate) {
                    dateDirs = dateDirs.filter(date => date > baseCheckpointDate)
                }

                for (const dateDir of dateDirs) {
                    const rawJsonPath = path.join(HISTORY_DIR, dateDir, `${userIdStr}.json`)
                    if (!fs.existsSync(rawJsonPath)) continue

                    if (dateDir === todayStr) {
                        try {
                            const content = fs.readFileSync(rawJsonPath, 'utf8')
                            const dayHistory = JSON.parse(content)
                            let todayText = ""
                            for (const turn of dayHistory) {
                                const role = turn.role === 'user' ? '用户' : '诺亚'
                                const text = turn.parts.map(p => p.text).join(' ')
                                if (text) todayText += `${role}: ${text}\n`
                            }
                            if (todayText) {
                                finalContext += `\n=== 🔥 【今天 (${dateDir}) 的实时对话】 ===\n${todayText}\n`
                            }
                        } catch (err) { }
                    } else {
                        processedDays++
                        const summary = await this._getOrCreateDailySummary(dateDir, userIdStr, rawJsonPath, modelGroupKey)
                        if (summary) {
                            const cleanSummary = summary.replace(/^【.*?】:\s*/, '')
                            finalContext += `\n=== ➕ 【增量记忆 (${dateDir})】 ===\n${cleanSummary}\n`
                        }
                    }
                }
            }

            if (!finalContext.trim()) {
                return e.reply("没有找到需要归档的内容喵...")
            }

        } catch (error) {
            logger.error(`[AI-Plugin] 归档失败:`, error)
            return e.reply("整理记忆碎片时出错了...")
        }

        const currentTime = new Date().toLocaleString('zh-CN', { hour12: false })

        let finalPrompt = `你是一位专业的传记作家和档案管理员。现在是【${currentTime}】。\n`
        if (baseCheckpointDate) {
            finalPrompt += `这是一次【记忆存档接力 (Update)】操作。请基于旧的【核心记忆存档】，合并后续的【增量记忆】和【今天的对话】，生成一份**最新的**人生总结报告。**关键要求**：旧存档中的核心设定（背景、性格、长期经历）非常重要，请务必继承和保留，不要丢失细节。\n`
        } else {
            finalPrompt += `这是一次【记忆存档重构 (Rebuild)】操作。请阅读以下用户每一天的【每日摘要】和【今天的对话】，将这些碎片化的信息整合成一份**完整的、连贯的**人生总结报告。\n`
        }
        finalPrompt += `输出要求：\n1. 报告将作为**新的存档文件**保存，供未来使用，请确保信息密度高。\n2. 请用第三人称叙述。\n3. 重点关注：用户的性格变化、核心人际关系、重要事件的时间线。\n\n--- 🗂️ 待处理数据 ---\n${finalContext}\n--- 数据结束 ---`

        await e.reply(`📖 正在生成新的记忆锚点...\n(模式: ${baseCheckpointDate ? '增量接力' : '全量重构'} | 覆盖天数: ${processedDays}天)`, true)

        try {
            const payload = { "contents": [{ "role": "user", "parts": [{ "text": finalPrompt }] }] }
            const result = await this.client.makeRequest('chat', payload, modelGroupKey)

            if (result.success) {
                const newSummary = result.data
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

                let tokenInfo = ''
                if (result.usage) {
                    if (result.usage.prompt_tokens !== undefined && result.usage.completion_tokens !== undefined) {
                        tokenInfo = ` | In: ${result.usage.prompt_tokens} | Out: ${result.usage.completion_tokens}`
                    } else if (result.usage.total_tokens) {
                        tokenInfo = ` | Total: ${result.usage.total_tokens}`
                    }
                }

                const modelInfo = result.platform ? `\n🔮 模型: ${result.platform}` : ''

                const newCheckpointFile = path.join(CHECKPOINT_DIR, `${userIdStr}_${todayStr}.txt`)
                fs.writeFileSync(newCheckpointFile, newSummary, 'utf8')

                const HISTORY_DIR = path.join(process.cwd(), 'data', 'ai_assistant', 'user_histories')
                let currentHistory = await this.conversationManager.getUserHistory(e.user_id)
                currentHistory.push({
                    "role": "model",
                    "parts": [{ "text": `(系统：[${todayStr}] 记忆锚点已建立。)\n${newSummary}` }]
                })
                await this.conversationManager.saveUserHistory(e.user_id, currentHistory)

                const forwardMsgNodes = [
                    {
                        user_id: Bot.uin,
                        nickname: "诺亚",
                        message: `✅ 锚点创建成功！${modelInfo}\n⏱️ 耗时: ${elapsed}s${tokenInfo}\n💾 新文件名: ${userIdStr}_${todayStr}.txt\n🔗 继承自: ${baseCheckpointDate || '无 (重构)'}`
                    }
                ]

                const MAX_LENGTH = 3500
                if (newSummary.length <= MAX_LENGTH) {
                    forwardMsgNodes.push({
                        user_id: Bot.uin,
                        nickname: "存档预览",
                        message: newSummary
                    })
                } else {
                    let content = newSummary
                    let part = 1
                    while (content.length > 0) {
                        let splitIndex = MAX_LENGTH
                        if (content.length > MAX_LENGTH) {
                            const lastNewLine = content.lastIndexOf('\n', MAX_LENGTH)
                            if (lastNewLine > MAX_LENGTH * 0.8) splitIndex = lastNewLine + 1
                        }
                        const chunk = content.slice(0, splitIndex)
                        content = content.slice(splitIndex)
                        forwardMsgNodes.push({
                            user_id: Bot.uin,
                            nickname: `存档预览 (Part ${part++})`,
                            message: chunk
                        })
                    }
                }

                const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
                await e.reply(forwardMsg)

            } else {
                await e.reply(`❌ 锚点生成失败: ${result.error}`)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 最终锚点生成出错:`, err)
            await e.reply(`❌ 错误: ${err.message}`)
        }
    }

    async createFullCheckpoint(e) {
        return await this._runCheckpointLogic(e, true)
    }

    async createIncrementalCheckpoint(e) {
        return await this._runCheckpointLogic(e, false)
    }

    async listMemorySummaries(e) {
        if (!await checkAccess(e)) return true

        const userIdStr = String(e.user_id)
        const HISTORY_DIR = path.join(process.cwd(), 'data', 'ai_assistant', 'user_histories')

        if (!fs.existsSync(HISTORY_DIR)) {
            return e.reply("诺亚找遍了柜子，目前还没有任何按日期的历史存档呢。")
        }

        const dateDirs = fs.readdirSync(HISTORY_DIR)
            .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(path.join(HISTORY_DIR, name)).isDirectory())
            .sort()

        let listContent = []
        let totalDays = 0
        let summarizedCount = 0
        let checkpointCount = 0
        const todayStr = getTodayDateStr()

        for (const date of dateDirs) {
            const historyFile = path.join(HISTORY_DIR, date, `${userIdStr}.json`)
            if (!fs.existsSync(historyFile)) continue

            totalDays++

            const summaryFile = path.join(SUMMARY_CACHE_DIR, date, `${userIdStr}.txt`)
            const hasSummary = fs.existsSync(summaryFile)

            const checkpointFile = path.join(CHECKPOINT_DIR, `${userIdStr}_${date}.txt`)
            const hasCheckpoint = fs.existsSync(checkpointFile)

            let statusIcon = ""
            let statusText = ""

            if (date === todayStr) {
                statusIcon = "📝"
                statusText = "(记录中)"
            } else if (hasCheckpoint) {
                statusIcon = "💾"
                statusText = "(锚点存档)"
                checkpointCount++
                summarizedCount++
            } else if (hasSummary) {
                statusIcon = "✅"
                statusText = "(已总结)"
                summarizedCount++
            } else {
                statusIcon = "☁️"
                statusText = "(未总结)"
            }

            listContent.push(`${statusIcon} ${date} ${statusText}`)
        }

        if (listContent.length === 0) {
            return e.reply("诺亚还没有关于你的任何按日存档哦。多和我聊聊天吧！")
        }

        listContent.reverse()

        const header = `📜 记忆档案列表 (共${totalDays}天)\n💾 锚点存档: ${checkpointCount}个\n✅ 每日摘要: ${summarizedCount}天\n- - - - - - - - - -`

        const forwardMsgNodes = [
            {
                user_id: Bot.uin,
                nickname: "诺亚",
                message: header + "\n" + listContent.join("\n")
            },
            {
                user_id: Bot.uin,
                nickname: "图例说明",
                message: "💾 锚点存档：包含该日期之前的所有核心记忆 (里程碑)。\n✅ 已总结：该日期的流水账已生成摘要 (增量)。\n☁️ 未总结：原始对话尚未处理。\n📝 记录中：今天的实时对话。"
            }
        ]

        if (checkpointCount === 0 && summarizedCount < totalDays - 1) {
            forwardMsgNodes.push({
                user_id: Bot.uin,
                nickname: "提示",
                message: "💡 建议使用 #gemini创建全量锚点 来生成你的第一个记忆里程碑哦！"
            })
        }

        const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
        await e.reply(forwardMsg)
    }
}
