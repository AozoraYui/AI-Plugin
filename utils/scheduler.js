import schedule from 'node-schedule'
import { getTodayDateStr, generateDailySummary } from './common.js'
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

        // 从数据库获取最新全量锚点
        let latestCheckpoint = await global.AIPluginConversationManager.db.getLatestCheckpoint(userId)
        let baseCheckpointDate = null
        let baseCheckpointContent = ""

        if (latestCheckpoint) {
            baseCheckpointDate = latestCheckpoint.dateStr
            baseCheckpointContent = latestCheckpoint.content
        }

        let finalContext = ""
        if (baseCheckpointDate && baseCheckpointContent) {
            finalContext += `\n=== 📜 【核心记忆存档 (截止于 ${baseCheckpointDate})】 ===\n${baseCheckpointContent}\n`
        }

        const dateDirs = await global.AIPluginConversationManager.db.getDistinctDates(userId)

        let datesToProcess = dateDirs
        if (baseCheckpointDate) {
            const baseIndex = datesToProcess.indexOf(baseCheckpointDate)
            if (baseIndex !== -1) {
                datesToProcess = datesToProcess.slice(baseIndex)
            }
        }

        for (const dateDir of datesToProcess) {
            const dayHistory = await global.AIPluginConversationManager.db.getConversationHistoryByDate(userId, dateDir)
            if (dayHistory.length === 0) continue

            const summaryText = await generateDailySummary(this.client, userId, dateDir, dayHistory, 'default')
            if (!summaryText) continue

            finalContext += `\n=== 📅 【${dateDir} 记忆摘要】 ===\n${summaryText}\n`
        }

        if (!finalContext.trim()) {
            logger.debug(`[AI-Plugin] 用户 ${userId} 没有可归档的记忆，跳过`)
            return
        }

        // 保存到数据库，附带消息计数和锚点类型
        await global.AIPluginConversationManager.db.saveCheckpoint(userId, finalContext, today, messageCount, 'incremental')
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
        let finalContext = ""

        const dateDirs = await global.AIPluginConversationManager.db.getDistinctDates(userId)

        for (const dateDir of dateDirs) {
            const dayHistory = await global.AIPluginConversationManager.db.getConversationHistoryByDate(userId, dateDir)
            if (dayHistory.length === 0) continue

            const summaryText = await generateDailySummary(this.client, userId, dateDir, dayHistory, 'default')
            if (!summaryText) continue

            finalContext += `\n=== 📅 【${dateDir} 记忆摘要】 ===\n${summaryText}\n`
        }

        if (!finalContext.trim()) {
            logger.debug(`[AI-Plugin] 用户 ${userId} 没有可归档的记忆，跳过`)
            return
        }

        // 保存到数据库，记录锚点类型
        await global.AIPluginConversationManager.db.saveCheckpoint(userId, finalContext, today, 0, 'full')
        logger.info(`[AI-Plugin] 为用户 ${userId} 创建全量锚点成功: ${today}`)
    }
}
