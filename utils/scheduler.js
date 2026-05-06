import schedule from 'node-schedule'
import { getTodayDateStr, isAIErrorResponse } from './common.js'
import { Config } from './config.js'

const FULL_CHUNK_SIZE = 128

export class AIScheduler {
    constructor(client) {
        this.client = client
        this.jobs = {}
    }

    start() {
        this.jobs.dailyIncremental = schedule.scheduleJob('50 23 * * *', async () => {
            logger.info('[AI-Plugin] 开始执行每日增量锚点总结任务...')
            await this._runDailyIncrementalCheckpoint()
        })

        this.jobs.weeklyFull = schedule.scheduleJob('0 2 * * 0', async () => {
            logger.info('[AI-Plugin] 开始执行每周全量锚点总结任务...')
            await this._runWeeklyFullCheckpoint()
        })

        logger.info('[AI-Plugin] 定时任务已启动: 每日23:50增量锚点, 每周日02:00全量锚点')
    }

    stop() {
        Object.values(this.jobs).forEach(job => job.cancel())
        this.jobs = {}
        logger.info('[AI-Plugin] 定时任务已停止')
    }

    async _runDailyIncrementalCheckpoint() {
        const today = getTodayDateStr()
        const userIds = await global.AIPluginConversationManager.db.getAllUserIds()

        if (userIds.length === 0) {
            logger.info('[AI-Plugin] 没有用户对话记录，跳过增量锚点总结')
            return
        }

        for (const userId of userIds) {
            try {
                const userTodayHistory = await global.AIPluginConversationManager.db.getConversationHistoryByDate(userId, today)
                if (userTodayHistory.length === 0) continue
                await this._createIncrementalCheckpoint(userId, today)
            } catch (err) {
                logger.error(`[AI-Plugin] 为用户 ${userId} 创建增量锚点失败:`, err)
            }
        }
    }

    async _createIncrementalCheckpoint(userId, today, _messageCount = 0, modelGroupKey = 'flash') {

        // 获取今天的对话记录
        const todayHistory = await global.AIPluginConversationManager.db.getConversationHistoryByDate(userId, today)
        if (todayHistory.length === 0) {
            logger.debug(`[AI-Plugin] 用户 ${userId} 今天没有对话，跳过增量总结`)
            return
        }

        // 获取最近一份全量总结
        const latestFullCheckpoint = await global.AIPluginConversationManager.db.getLatestFullCheckpoint(userId)

        let todayContent = ""
        const aiName = Config.AI_NAME || '诺亚'
        for (const turn of todayHistory) {
            const role = turn.role === 'user' ? '用户' : aiName
            const text = turn.parts.map(p => p.text).join(' ')
            if (text) todayContent += `${role}: ${text}\n`
        }

        if (!todayContent.trim()) return

        let summaryPrompt = ""
        if (latestFullCheckpoint) {
            summaryPrompt = `
请将以下这段发生在【${today}】的对话概括为一个简短的摘要（${Config.SUMMARY_MAX_LENGTH}字以内）。
重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
直接输出摘要内容，不要加"好的"等客套话。

以下是之前的核心记忆存档，供你参考上下文（不需要重复总结这些内容）：
=== 📜 【核心记忆存档 (截止于 ${latestFullCheckpoint.dateStr})】 ===
${latestFullCheckpoint.content}

今天的对话内容：
${todayContent}`
        } else {
            summaryPrompt = `
请将以下这段发生在【${today}】的对话概括为一个简短的摘要（${Config.SUMMARY_MAX_LENGTH}字以内）。
重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
直接输出摘要内容，不要加"好的"等客套话。
对话内容：
${todayContent}`
        }

        const payload = { "contents": [{ "role": "user", "parts": [{ "text": summaryPrompt }] }] }
        const result = await this.client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

        let summaryText = ""
        if (result.success && !isAIErrorResponse(result.data)) {
            summaryText = result.data.trim()
        } else {
            const reason = isAIErrorResponse(result.data) ? 'AI 安全过滤拦截' : (result.error || '未知错误')
            logger.warn(`[AI-Plugin] ${today} 增量总结生成失败: ${reason}`)
            summaryText = `【${today} 原始片段】: ${todayContent.slice(0, 500)}...`
        }

        const tokenLog = result.usage
            ? ` | Token: 入${result.usage.prompt_tokens || '?'} 出${result.usage.completion_tokens || '?'}`
            : ''
        await global.AIPluginConversationManager.db.saveSummaryCache(userId, summaryText, today)
        logger.info(`[AI-Plugin] 为用户 ${userId} 创建增量总结成功: ${today}${tokenLog}`)
    }

    async _runWeeklyFullCheckpoint() {
        const today = getTodayDateStr()
        const userIds = await global.AIPluginConversationManager.db.getAllUserIds()

        if (userIds.length === 0) {
            logger.info('[AI-Plugin] 没有用户对话记录，跳过全量锚点总结')
            return
        }

        for (const userId of userIds) {
            try {
                await this._createFullCheckpoint(userId, today)
            } catch (err) {
                logger.error(`[AI-Plugin] 为用户 ${userId} 创建全量锚点失败:`, err)
            }
        }
    }

    async _createFullCheckpoint(userId, today) {

        const allHistory = await global.AIPluginConversationManager.db.getConversationHistory(userId)

        if (allHistory.length === 0) {
            logger.debug(`[AI-Plugin] 用户 ${userId} 没有可归档的记忆，跳过`)
            return
        }

        const aiName = Config.AI_NAME || '诺亚'

        let chunkUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

        const addChunkUsage = (usage) => {
            if (!usage) return
            if (usage.prompt_tokens) chunkUsage.prompt_tokens += usage.prompt_tokens
            if (usage.completion_tokens) chunkUsage.completion_tokens += usage.completion_tokens
            if (usage.total_tokens) chunkUsage.total_tokens += usage.total_tokens
        }

        if (allHistory.length <= FULL_CHUNK_SIZE) {
            const historyText = this._buildHistoryText(allHistory, aiName)
            if (!historyText.trim()) return
            const result = await this._summarizeSingleChunk(historyText, 'flash')
            addChunkUsage(result.usage)
            await global.AIPluginConversationManager.db.saveCheckpoint(userId, result.summary, today, 0, 'full')
            logger.info(`[AI-Plugin] 为用户 ${userId} 创建全量锚点成功: ${today} (${allHistory.length}条) | Token: 入${chunkUsage.prompt_tokens} 出${chunkUsage.completion_tokens}`)
            return
        }

        const chunks = []
        for (let i = 0; i < allHistory.length; i += FULL_CHUNK_SIZE) {
            chunks.push(allHistory.slice(i, i + FULL_CHUNK_SIZE))
        }
        logger.info(`[AI-Plugin] 用户 ${userId} 共 ${allHistory.length} 条对话，分 ${chunks.length} 块总结`)

        const chunkSummaries = []
        for (let i = 0; i < chunks.length; i++) {
            const chunkText = this._buildHistoryText(chunks[i], aiName)
            if (!chunkText.trim()) continue
            logger.info(`[AI-Plugin] 正在总结第 ${i + 1}/${chunks.length} 块 (${chunks[i].length}条)...`)
            const result = await this._summarizeChunk(chunkText, i + 1, chunks.length, 'flash')
            if (result) {
                chunkSummaries.push(result.summary)
                addChunkUsage(result.usage)
                logger.info(`[AI-Plugin] 第 ${i + 1}/${chunks.length} 块总结完成`)
            } else {
                logger.warn(`[AI-Plugin] 第 ${i + 1}/${chunks.length} 块总结失败，使用原始片段`)
                chunkSummaries.push(chunkText.slice(0, 2000))
            }
        }

        if (chunkSummaries.length === 0) {
            logger.warn(`[AI-Plugin] 用户 ${userId} 所有分块总结均失败`)
            return
        }

        logger.info(`[AI-Plugin] 正在合并 ${chunkSummaries.length} 个分块总结...`)
        const mergePrompt = `
请将以下 ${chunkSummaries.length} 个分段的对话摘要整合成一份完整的、精炼的核心记忆存档。
要求：
1. 保留所有重要的用户信息（性格、偏好、技术能力、重要经历等）
2. 按主题分类整理（如：个人信息、技术兴趣、重要对话、情感偏好等）
3. 去除重复的内容，保留核心内容
4. 字数不限，尽可能写好各处细节
5. 直接输出整合后的记忆存档，不要加"好的"等客套话

以下是各分段摘要：
${chunkSummaries.map((s, i) => `=== 第${i + 1}段 ===\n${s}`).join('\n\n')}`

        const payload = { "contents": [{ "role": "user", "parts": [{ "text": mergePrompt }] }] }
        const result = await this.client.makeRequest('chat', payload, 'flash', Config.CHECKPOINT_MAX_LENGTH)

        let fullContext = ""
        let mergeUsage = null
        if (result.success && !isAIErrorResponse(result.data)) {
            fullContext = result.data.trim()
            mergeUsage = result.usage || null
        } else {
            const reason = isAIErrorResponse(result.data) ? 'AI 安全过滤拦截' : (result.error || '未知错误')
            logger.warn(`[AI-Plugin] ${today} 全量总结合并失败: ${reason}`)
            fullContext = chunkSummaries.join('\n\n')
        }

        await global.AIPluginConversationManager.db.saveCheckpoint(userId, fullContext, today, 0, 'full')

        let tokenLog = `分段入${chunkUsage.prompt_tokens} 出${chunkUsage.completion_tokens}`
        if (mergeUsage) {
            tokenLog += ` | 合并入${mergeUsage.prompt_tokens} 出${mergeUsage.completion_tokens}`
            const totalIn = chunkUsage.prompt_tokens + mergeUsage.prompt_tokens
            const totalOut = chunkUsage.completion_tokens + mergeUsage.completion_tokens
            tokenLog += ` | 合计入${totalIn} 出${totalOut}`
        }
        logger.info(`[AI-Plugin] 为用户 ${userId} 创建全量锚点成功: ${today} (${allHistory.length}条, ${chunks.length}块) | ${tokenLog}`)
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
请将以下这些原始对话整合成一份完整的、精炼的核心记忆存档。
要求：
1. 保留所有重要的用户信息（性格、偏好、技术能力、重要经历等）
2. 按主题分类整理（如：个人信息、技术兴趣、重要对话、情感偏好等）
3. 去除重复的内容，保留核心内容
4. 字数不限，尽可能写好各处细节
5. 直接输出整合后的记忆存档，不要加"好的"等客套话

原始对话记录：
${historyText}`

        const payload = { "contents": [{ "role": "user", "parts": [{ "text": prompt }] }] }
        const result = await this.client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

        if (result.success && !isAIErrorResponse(result.data)) {
            return { summary: result.data.trim(), usage: result.usage || null }
        }
        return { summary: historyText.slice(0, Config.CHECKPOINT_MAX_LENGTH), usage: null }
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
            return { summary: result.data.trim(), usage: result.usage || null }
        }
        return null
    }
}
