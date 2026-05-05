import schedule from 'node-schedule'
import { getTodayDateStr } from './common.js'
import { Config } from './config.js'

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

    async _createIncrementalCheckpoint(userId, today, messageCount = 0) {
        const userIdStr = String(userId)

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
        const result = await this.client.makeRequest('chat', payload, 'default', Config.CHECKPOINT_MAX_LENGTH)

        let summaryText = ""
        if (result.success) {
            summaryText = result.data.trim()
        } else {
            logger.warn(`[AI-Plugin] ${today} 增量总结生成失败: ${result.error}`)
            summaryText = `【${today} 原始片段】: ${todayContent.slice(0, 500)}...`
        }

        // 保存到数据库
        await global.AIPluginConversationManager.db.saveCheckpoint(userId, summaryText, today, messageCount, 'incremental')
        logger.info(`[AI-Plugin] 为用户 ${userId} 创建增量锚点成功: ${today}`)
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
        const userIdStr = String(userId)

        // 获取所有每日摘要
        const allSummaries = await global.AIPluginConversationManager.db.getAllSummaryCaches(userId)

        if (allSummaries.length === 0) {
            logger.debug(`[AI-Plugin] 用户 ${userId} 没有可归档的记忆，跳过`)
            return
        }

        // 拼接所有每日摘要
        let summariesText = ""
        for (const summary of allSummaries) {
            summariesText += `\n=== 📅 【${summary.dateStr} 记忆摘要】 ===\n${summary.content}\n`
        }

        // 让 AI 整合成一份完整的记忆存档
        const fullSummaryPrompt = `
请将以下这些每日对话摘要整合成一份完整的、精炼的核心记忆存档。
要求：
1. 保留所有重要的用户信息（性格、偏好、技术能力、重要经历等）
2. 按主题分类整理（如：个人信息、技术兴趣、重要对话、情感偏好等）
3. 去除重复和琐碎的细节，保留核心内容
4. 总字数控制在5000字以内
5. 直接输出整合后的记忆存档，不要加"好的"等客套话

每日摘要列表：
${summariesText}`

        const payload = { "contents": [{ "role": "user", "parts": [{ "text": fullSummaryPrompt }] }] }
        const result = await this.client.makeRequest('chat', payload, 'default', Config.CHECKPOINT_MAX_LENGTH)

        let fullContext = ""
        if (result.success) {
            fullContext = result.data.trim()
        } else {
            logger.warn(`[AI-Plugin] ${today} 全量总结生成失败: ${result.error}`)
            // 如果整合失败，回退到直接拼接摘要
            fullContext = summariesText.slice(0, Config.CHECKPOINT_MAX_LENGTH)
        }

        // 保存到数据库，记录锚点类型
        await global.AIPluginConversationManager.db.saveCheckpoint(userId, fullContext, today, 0, 'full')
        logger.info(`[AI-Plugin] 为用户 ${userId} 创建全量锚点成功: ${today}`)
    }
}
