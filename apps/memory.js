import plugin from '../../../lib/plugins/plugin.js'
import path from 'node:path'
import yaml from 'yaml'
import { Config } from '../utils/config.js'
import { GeminiClient } from '../client/GeminiClient.js'
import { ConversationManager } from '../model/conversation.js'
import { checkAccess } from '../utils/access.js'
import { sessionManager } from '../utils/session.js'
import { setMsgEmojiLike, getTodayDateStr, generateDailySummary, isAIErrorResponse } from '../utils/common.js'

export class MemoryHandler extends plugin {
    constructor() {
        super({
            name: 'AI记忆管理',
            dsc: '管理AI的记忆锚点和总结',
            event: 'message',
            priority: 1146,
            rule: [
                { reg: /^#([a-zA-Z0-9]*)gemini创建全量总结$/i, fnc: "createFullCheckpoint" },
                { reg: /^#([a-zA-Z0-9]*)gemini创建增量总结$/i, fnc: "createIncrementalCheckpoint" },
                { reg: /^#([a-zA-Z0-9]*)gemini批量增量总结$/i, fnc: "batchIncrementalSummaries" },
                { reg: /^#gemini记忆列表$/i, fnc: "listMemorySummaries" },
                { reg: /^#([a-zA-Z0-9]*)gemini读取记忆\s*(\d{4}-\d{2}-\d{2})$/i, fnc: "readMemory", key: "readMemoryCommand" },
            ]
        })
        this.client = global.AIPluginClient
        this.conversationManager = global.AIPluginConversationManager
    }

    async _getOrCreateDailySummary(dateDir, userId, modelGroupKey) {
        // 从数据库获取摘要缓存
        const dbSummary = await this.conversationManager.db.getSummaryCache(userId, dateDir)
        if (dbSummary) {
            logger.debug(`[AI-Plugin] 命中摘要缓存: ${dateDir}`)
            return `【${dateDir} 摘要】: ${dbSummary.content}`
        }

        // 从数据库获取当日对话历史
        const dayHistory = await this.conversationManager.db.getConversationHistoryByDate(userId, dateDir)
        if (dayHistory.length === 0) return ""

        const summaryText = await generateDailySummary(this.client, userId, dateDir, dayHistory, modelGroupKey)
        if (!summaryText) return ""

        return `【${dateDir} 摘要】: ${summaryText}`
    }

    async _runCheckpointLogic(e, isFullRebuild) {
        if (!await checkAccess(e)) return true

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

        let statusMsg = `📚 正在启动记忆归档 [${modelDisplay}]...`
        statusMsg += isFullRebuild
            ? `\n🔥 全量模式: 读取所有原始对话记录，整合成一份完整记忆存档`
            : `\n🔗 增量模式: 读取今天对话 + 最近全量总结，生成今日摘要`

        await e.reply(statusMsg, true)

        const startTime = Date.now()

        try {
            if (isFullRebuild) {
                await this._createFullCheckpointManual(e, userIdStr, todayStr, modelGroupKey, startTime)
            } else {
                await this._createIncrementalCheckpointManual(e, userIdStr, todayStr, modelGroupKey, startTime)
            }
        } catch (error) {
            logger.error(`[AI-Plugin] 归档失败:`, error)
            return e.reply("整理记忆碎片时出错了...")
        }
    }

    async _createFullCheckpointManual(e, userIdStr, todayStr, modelGroupKey, startTime) {
        const allHistory = await this.conversationManager.db.getConversationHistory(userIdStr)
        if (allHistory.length === 0) {
            return e.reply("没有找到任何对话记录，无法创建全量总结喵...")
        }

        const aiName = Config.AI_NAME || '诺亚'
        const FULL_CHUNK_SIZE = 128

        if (allHistory.length <= FULL_CHUNK_SIZE) {
            const historyText = this._buildHistoryText(allHistory, aiName)
            await e.reply(`📖 正在整合 ${allHistory.length} 条对话记录...`, true)
            const newSummary = await this._summarizeSingleChunk(historyText, modelGroupKey)
            if (!newSummary) {
                return e.reply(`❌ 全量总结生成失败`)
            }
            await this.conversationManager.db.saveCheckpoint(e.user_id, newSummary, todayStr, 0, 'full')
            return this._sendFullCheckpointResult(e, newSummary, allHistory.length, 1, startTime, modelGroupKey)
        }

        const chunks = []
        for (let i = 0; i < allHistory.length; i += FULL_CHUNK_SIZE) {
            chunks.push(allHistory.slice(i, i + FULL_CHUNK_SIZE))
        }
        await e.reply(`📚 共 ${allHistory.length} 条对话，分 ${chunks.length} 块总结 (每块${FULL_CHUNK_SIZE}条)...`, true)

        const chunkSummaries = []
        for (let i = 0; i < chunks.length; i++) {
            const chunkText = this._buildHistoryText(chunks[i], aiName)
            if (!chunkText.trim()) continue
            await e.reply(`📝 正在总结第 ${i + 1}/${chunks.length} 块 (${chunks[i].length}条)...`, true)
            const summary = await this._summarizeChunk(chunkText, i + 1, chunks.length, modelGroupKey)
            if (summary) {
                chunkSummaries.push(summary)
            } else {
                logger.warn(`[AI-Plugin] 第 ${i + 1}/${chunks.length} 块总结失败，使用原始片段`)
                chunkSummaries.push(chunkText.slice(0, 2000))
            }
        }

        if (chunkSummaries.length === 0) {
            return e.reply(`❌ 所有分块总结均失败`)
        }

        await e.reply(`🔗 正在合并 ${chunkSummaries.length} 个分块总结...`, true)

        const mergePrompt = `
请将以下 ${chunkSummaries.length} 个分段的对话摘要整合成一份完整的、精炼的核心记忆存档。
要求：
1. 保留所有重要的用户信息（性格、偏好、技术能力、重要经历等）
2. 按主题分类整理（如：个人信息、技术兴趣、重要对话、情感偏好等）
3. 去除重复的内容，保留核心内容
5. 直接输出整合后的记忆存档，不要加"好的"等客套话

以下是各分段摘要：
${chunkSummaries.map((s, i) => `=== 第${i + 1}段 ===\n${s}`).join('\n\n')}`

        const payload = { "contents": [{ "role": "user", "parts": [{ "text": mergePrompt }] }] }
        const result = await this.client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

        if (!result.success || isAIErrorResponse(result.data)) {
            const reason = isAIErrorResponse(result.data) ? 'AI 安全过滤拦截' : (result.error || '未知错误')
            return e.reply(`❌ 全量总结合并失败: ${reason}`)
        }

        const newSummary = result.data
        await this.conversationManager.db.saveCheckpoint(e.user_id, newSummary, todayStr, 0, 'full')
        return this._sendFullCheckpointResult(e, newSummary, allHistory.length, chunks.length, startTime, modelGroupKey)
    }

    _buildHistoryText(history, aiName) {
        let text = ""
        for (const turn of history) {
            const role = turn.role === 'user' ? '用户' : aiName
            const content = turn.parts.map(p => p.text).join(' ')
            if (content) text += `${role}: ${content}\n`
        }
        return text
    }

    async _summarizeSingleChunk(historyText, modelGroupKey) {
        const prompt = `
你是一位专业的传记作家和档案管理员。现在是【${new Date().toLocaleString('zh-CN', { hour12: false })}】。
请将以下这些原始对话整合成一份完整的、精炼的核心记忆存档。
要求：
1. 保留所有重要的用户信息（性格、偏好、技术能力、重要经历等）
2. 按主题分类整理（如：个人信息、技术兴趣、重要对话、情感偏好等）
3. 去除重复的内容，保留核心内容
5. 直接输出整合后的记忆存档，不要加"好的"等客套话

原始对话记录：
${historyText}`

        const payload = { "contents": [{ "role": "user", "parts": [{ "text": prompt }] }] }
        const result = await this.client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

        if (result.success && !isAIErrorResponse(result.data)) {
            return result.data.trim()
        }
        return null
    }

    async _summarizeChunk(chunkText, chunkIndex, totalChunks, modelGroupKey) {
        const prompt = `
请将以下这段对话记录概括为一个详细的摘要（这是第 ${chunkIndex}/${totalChunks} 段）。
重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好、重要的个人信息。
直接输出摘要内容，不要加"好的"等客套话。

对话记录：
${chunkText}`

        const payload = { "contents": [{ "role": "user", "parts": [{ "text": prompt }] }] }
        const result = await this.client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

        if (result.success && !isAIErrorResponse(result.data)) {
            return result.data.trim()
        }
        return null
    }

    async _sendFullCheckpointResult(e, newSummary, totalMessages, totalChunks, startTime, modelGroupKey) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

        const modelInfo = modelGroupKey === 'pro' ? '\n🔮 模型组: Pro' : modelGroupKey === 'gemini3' ? '\n🔮 模型组: Gemini 3' : '\n🔮 模型组: Flash'

        const forwardMsgNodes = [
            {
                user_id: e.self_id,
                nickname: Config.AI_NAME,
                message: `✅ 全量锚点创建成功！${modelInfo}\n⏱️ 耗时: ${elapsed}s\n📚 整合了 ${totalMessages} 条对话记录${totalChunks > 1 ? ` (${totalChunks}块分组合并)` : ''}`
            }
        ]

        const MAX_LENGTH = Config.CHECKPOINT_DISPLAY_MAX_LENGTH
        if (newSummary.length <= MAX_LENGTH) {
            forwardMsgNodes.push({
                user_id: e.self_id,
                nickname: "记忆存档内容",
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
                    user_id: e.self_id,
                    nickname: `存档预览 (Part ${part++})`,
                    message: chunk
                })
            }
        }

        const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
        await e.reply(forwardMsg)
    }

    async _createIncrementalCheckpointManual(e, userIdStr, todayStr, modelGroupKey, startTime) {
        const todayHistory = await this.conversationManager.db.getConversationHistoryByDate(userIdStr, todayStr)
        if (todayHistory.length === 0) {
            return e.reply("今天还没有对话记录，无法创建增量总结喵...")
        }

        const latestFullCheckpoint = await this.conversationManager.db.getLatestFullCheckpoint(userIdStr)

        let todayContent = ""
        for (const turn of todayHistory) {
            const role = turn.role === 'user' ? '用户' : Config.AI_NAME
            const text = turn.parts.map(p => p.text).join(' ')
            if (text) todayContent += `${role}: ${text}\n`
        }

        let summaryPrompt = ""
        if (latestFullCheckpoint) {
            summaryPrompt = `
你是一位专业的档案管理员。现在是【${new Date().toLocaleString('zh-CN', { hour12: false })}】。
请将以下这段发生在【${todayStr}】的对话概括为一个简短的摘要（${Config.SUMMARY_MAX_LENGTH}字以内）。
重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
直接输出摘要内容，不要加"好的"等客套话。

以下是之前的核心记忆存档，供你参考上下文（不需要重复总结这些内容）：
=== 📜 【核心记忆存档 (截止于 ${latestFullCheckpoint.dateStr})】 ===
${latestFullCheckpoint.content}

今天的对话内容：
${todayContent}`
        } else {
            summaryPrompt = `
你是一位专业的档案管理员。现在是【${new Date().toLocaleString('zh-CN', { hour12: false })}】。
请将以下这段发生在【${todayStr}】的对话概括为一个简短的摘要（${Config.SUMMARY_MAX_LENGTH}字以内）。
重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
直接输出摘要内容，不要加"好的"等客套话。
对话内容：
${todayContent}`
        }

        await e.reply(`📖 正在生成今日增量总结...`, true)

        const payload = { "contents": [{ "role": "user", "parts": [{ "text": summaryPrompt }] }] }
        const result = await this.client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

        if (!result.success || isAIErrorResponse(result.data)) {
            const reason = isAIErrorResponse(result.data) ? 'AI 安全过滤拦截' : (result.error || '未知错误')
            return e.reply(`❌ 增量总结生成失败: ${reason}`)
        }

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

        await this.conversationManager.db.saveSummaryCache(e.user_id, newSummary, todayStr)

        const forwardMsgNodes = [
            {
                user_id: e.self_id,
                nickname: Config.AI_NAME,
                message: `✅ 增量总结创建成功！${modelInfo}\n⏱️ 耗时: ${elapsed}s${tokenInfo}\n🔗 基于全量总结: ${latestFullCheckpoint ? latestFullCheckpoint.dateStr : '无'}`
            },
            {
                user_id: e.self_id,
                nickname: "今日增量内容",
                message: newSummary
            }
        ]

        const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
        await e.reply(forwardMsg)
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

        // 从数据库获取所有日期
        const dateDirs = await this.conversationManager.db.getDistinctDates(userIdStr)
        if (dateDirs.length === 0) {
            return e.reply(`${Config.AI_NAME}找遍了柜子，目前还没有任何按日期的历史存档呢。`)
        }

        dateDirs.sort()

        let listContent = []
        let totalDays = 0
        let fullCheckpointCount = 0
        let incrementalCheckpointCount = 0
        const todayStr = getTodayDateStr()

        for (const date of dateDirs) {
            totalDays++

            const dbCheckpoint = await this.conversationManager.db.getCheckpoint(userIdStr, date)
            const dbSummary = await this.conversationManager.db.getSummaryCache(userIdStr, date)

            let statusIcon = ""
            let statusText = ""

            if (date === todayStr) {
                statusIcon = "📝"
                statusText = "(记录中)"
            } else if (dbCheckpoint && dbCheckpoint.checkpointType === 'full') {
                statusIcon = "💾"
                statusText = "(全量总结)"
                fullCheckpointCount++
                if (dbSummary) {
                    statusText += " + 🔗增量"
                    incrementalCheckpointCount++
                }
            } else if (dbSummary) {
                statusIcon = "🔗"
                statusText = "(增量总结)"
                incrementalCheckpointCount++
            } else {
                statusIcon = "☁️"
                statusText = "(未总结)"
            }

            listContent.push(`${statusIcon} ${date} ${statusText}`)
        }

        if (listContent.length === 0) {
            return e.reply(`${Config.AI_NAME}还没有关于你的任何按日存档哦。多和我聊聊天吧！`)
        }

        listContent.reverse()

        const header = `📜 记忆档案列表 (共${totalDays}天)\n💾 全量总结: ${fullCheckpointCount}个\n🔗 增量总结: ${incrementalCheckpointCount}个\n- - - - - - - - - -`

        const forwardMsgNodes = [
            {
                user_id: Bot.uin,
                nickname: Config.AI_NAME,
                message: header + "\n" + listContent.join("\n")
            },
            {
                user_id: Bot.uin,
                nickname: "图例说明",
                message: "💾 全量总结：包含该日期之前的所有核心记忆 (里程碑)。\n🔗 增量总结：基于上一个总结的接力存档 (每天23:50自动创建)。\n☁️ 未总结：原始对话尚未处理。\n📝 记录中：今天的实时对话。"
            }
        ]

        if (fullCheckpointCount === 0 && incrementalCheckpointCount === 0) {
            forwardMsgNodes.push({
                user_id: Bot.uin,
                nickname: "提示",
                message: "💡 建议使用 #gemini创建全量总结 来生成你的第一个记忆里程碑哦！"
            })
        }

        const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
        await e.reply(forwardMsg)
    }

    async readMemory(e) {
        if (!await checkAccess(e)) return true

        const userIdStr = String(e.user_id)
        const dateMatch = e.msg.match(/^#([a-zA-Z0-9]*)gemini读取记忆\s*(\d{4}-\d{2}-\d{2})$/i)
        const targetDate = dateMatch[2]

        try {
            const checkpoint = await this.conversationManager.db.getCheckpoint(userIdStr, targetDate)
            const isFullCheckpoint = checkpoint && checkpoint.checkpointType === 'full'

            if (isFullCheckpoint) {
                const DISPLAY_MAX = 3000
                const displayText = checkpoint.content.length > DISPLAY_MAX
                    ? checkpoint.content.slice(0, DISPLAY_MAX) + `\n\n... (内容过长，共 ${checkpoint.content.length} 字符，已截断。可使用 #gemini导出记忆 查看完整内容)`
                    : checkpoint.content
                const content = `📖 ${targetDate} 全量总结\n- - - - - - - - - -\n${displayText}`
                return this._sendMemoryContent(e, content, targetDate)
            }

            const summaryCache = await this.conversationManager.db.getSummaryCache(userIdStr, targetDate)
            if (summaryCache) {
                const DISPLAY_MAX = 3000
                const displayText = summaryCache.content.length > DISPLAY_MAX
                    ? summaryCache.content.slice(0, DISPLAY_MAX) + `\n\n... (内容过长，共 ${summaryCache.content.length} 字符，已截断)`
                    : summaryCache.content
                const content = `📖 ${targetDate} 增量总结\n- - - - - - - - - -\n${displayText}`
                return this._sendMemoryContent(e, content, targetDate)
            }

            return e.reply(`📅 没有找到 ${targetDate} 的记忆记录哦。\n该日期可能尚未进行总结，或者记录不存在。`)
        } catch (err) {
            logger.error(`[AI-Plugin] 读取记忆失败:`, err)
            await e.reply(`❌ 读取记忆失败: ${err.message}`)
        }
    }

    async _sendMemoryContent(e, content, targetDate) {
        const MAX_LENGTH = 800
        const MAX_NODES = 5
        if (content.length > MAX_LENGTH) {
            const forwardMsgNodes = [
                {
                    user_id: e.self_id,
                    nickname: Config.AI_NAME,
                    message: `📖 ${targetDate} 记忆记录`
                }
            ]

            let remainingContent = content
            let part = 1
            while (remainingContent.length > 0 && part <= MAX_NODES) {
                let chunk = remainingContent.slice(0, MAX_LENGTH)
                if (remainingContent.length > MAX_LENGTH) {
                    const lastNewline = chunk.lastIndexOf('\n')
                    if (lastNewline > MAX_LENGTH * 0.8) {
                        chunk = chunk.slice(0, lastNewline)
                    }
                }
                forwardMsgNodes.push({
                    user_id: e.self_id,
                    nickname: `记忆内容 (${part})`,
                    message: chunk
                })
                remainingContent = remainingContent.slice(chunk.length)
                part++
            }

            if (remainingContent.length > 0) {
                forwardMsgNodes.push({
                    user_id: e.self_id,
                    nickname: "提示",
                    message: `⚠️ 内容过长，仅显示前 ${MAX_NODES} 部分。\n如需查看完整内容，请使用 #gemini导出记忆 命令。`
                })
            }

            const forwardMsg = await Bot.makeForwardMsg(forwardMsgNodes)
            await e.reply(forwardMsg)
        } else {
            await e.reply(content)
        }
    }

    async batchIncrementalSummaries(e) {
        if (!await checkAccess(e)) return true

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

        // 从数据库获取所有日期
        const dateDirs = await this.conversationManager.db.getDistinctDates(userIdStr)
        if (dateDirs.length === 0) {
            return e.reply(`${Config.AI_NAME}找遍了柜子，目前还没有任何按日期的历史存档呢。`)
        }

        dateDirs.sort()

        // 找出所有"未总结"的日期（没有增量总结且不是今天）
        const unsummarizedDates = []
        for (const date of dateDirs) {
            if (date === todayStr) continue
            const dbSummary = await this.conversationManager.db.getSummaryCache(userIdStr, date)
            if (!dbSummary) {
                unsummarizedDates.push(date)
            }
        }

        if (unsummarizedDates.length === 0) {
            return e.reply(`✨ 所有日期都已经总结过啦！没有需要批量处理的日期哦。`)
        }

        await e.reply(`📚 开始批量增量总结 [${modelDisplay}]...\n共找到 ${unsummarizedDates.length} 个未总结的日期，正在逐个处理...`, true)

        const startTime = Date.now()
        let successCount = 0
        let failCount = 0
        let processedDates = []

        for (const dateDir of unsummarizedDates) {
            try {
                // 获取该日期的摘要
                const summary = await this._getOrCreateDailySummary(dateDir, userIdStr, modelGroupKey)
                if (!summary) {
                    failCount++
                    continue
                }

                const cleanSummary = summary.replace(/^【.*?】:\s*/, '')

                // 获取该日期之前的最新checkpoint作为基础
                const previousDates = dateDirs.filter(d => d < dateDir)
                let baseCheckpointContent = ""
                let baseCheckpointDate = null

                for (const prevDate of previousDates.reverse()) {
                    const prevCheckpoint = await this.conversationManager.db.getCheckpoint(userIdStr, prevDate)
                    if (prevCheckpoint) {
                        baseCheckpointDate = prevDate
                        baseCheckpointContent = prevCheckpoint.content
                        break
                    }
                }

                // 构建增量总结内容
                let finalContext = ""
                if (baseCheckpointDate && baseCheckpointContent) {
                    finalContext += `\n=== 📜 【核心记忆存档 (截止于 ${baseCheckpointDate})】 ===\n${baseCheckpointContent}\n`
                }
                finalContext += `\n=== ➕ 【增量记忆 (${dateDir})】 ===\n${cleanSummary}\n`

                const currentTime = new Date().toLocaleString('zh-CN', { hour12: false })
                let finalPrompt = `你是一位专业的传记作家和档案管理员。现在是【${currentTime}】。\n`
                if (baseCheckpointDate) {
                    finalPrompt += `这是一次【记忆存档接力 (Update)】操作。请基于旧的【核心记忆存档】，合并后续的【增量记忆】，生成一份**最新的**人生总结报告。**关键要求**：旧存档中的核心设定（背景、性格、长期经历）非常重要，请务必继承和保留，不要丢失细节。\n`
                } else {
                    finalPrompt += `这是一次【记忆存档重构 (Rebuild)】操作。请阅读以下用户的【每日摘要】，将这些碎片化的信息整合成一份**完整的、连贯的**人生总结报告。\n`
                }
                finalPrompt += `输出要求：\n1. 报告将作为**新的存档文件**保存，供未来使用，请确保信息密度高。\n2. 请用第三人称叙述。\n3. 重点关注：用户的性格变化、核心人际关系、重要事件的时间线。\n\n--- 🗂️ 待处理数据 ---\n${finalContext}\n--- 数据结束 ---`

                const payload = { "contents": [{ "role": "user", "parts": [{ "text": finalPrompt }] }] }
                const result = await this.client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

                if (result.success && !isAIErrorResponse(result.data)) {
                    const newSummary = result.data
                    await this.conversationManager.db.saveSummaryCache(userIdStr, newSummary, dateDir)
                    successCount++
                    processedDates.push(dateDir)
                    logger.info(`[AI-Plugin] 批量增量总结成功: ${dateDir}`)
                } else {
                    failCount++
                    const reason = isAIErrorResponse(result.data) ? 'AI 安全过滤拦截' : (result.error || '未知错误')
                    logger.warn(`[AI-Plugin] 批量增量总结失败: ${dateDir}, 错误: ${reason}`)
                }
            } catch (err) {
                failCount++
                logger.error(`[AI-Plugin] 批量增量总结异常: ${dateDir}`, err)
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)

        const resultMsg = `✅ 批量增量总结完成！\n⏱️ 总耗时: ${elapsed}s\n📊 成功: ${successCount}个 | 失败: ${failCount}个\n📅 处理日期: ${processedDates.slice(-5).join(', ')}${processedDates.length > 5 ? ` 等${processedDates.length}个` : ''}`

        await e.reply(resultMsg)
    }
}
