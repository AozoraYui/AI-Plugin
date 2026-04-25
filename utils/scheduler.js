import schedule from 'node-schedule'
import { SUMMARY_CACHE_DIR, CHECKPOINT_DIR } from './config.js'
import { getTodayDateStr } from './common.js'
import fs from 'node:fs'
import path from 'node:path'

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

    async _createIncrementalCheckpoint(userId, today) {
        if (!fs.existsSync(SUMMARY_CACHE_DIR)) {
            fs.mkdirSync(SUMMARY_CACHE_DIR, { recursive: true })
        }
        if (!fs.existsSync(CHECKPOINT_DIR)) {
            fs.mkdirSync(CHECKPOINT_DIR, { recursive: true })
        }

        const userIdStr = String(userId)

        // 优先从数据库获取最新全量锚点
        let latestCheckpoint = await global.AIPluginConversationManager.db.getLatestCheckpoint(userId)
        let baseCheckpointDate = null
        let baseCheckpointContent = ""

        if (latestCheckpoint) {
            baseCheckpointDate = latestCheckpoint.dateStr
            baseCheckpointContent = latestCheckpoint.content

            if (baseCheckpointDate === today) {
                logger.debug(`[AI-Plugin] 用户 ${userId} 今天已创建过锚点，跳过`)
                return
            }
        } else {
            // 降级：从文件读取
            const files = fs.readdirSync(CHECKPOINT_DIR)
                .filter(name => name.startsWith(`${userIdStr}_`) && name.endsWith('.txt'))
                .sort()
                .reverse()

            if (files.length > 0) {
                const latestFile = files[0]
                const match = latestFile.match(/_(\d{4}-\d{2}-\d{2})\.txt$/)
                if (match) {
                    baseCheckpointDate = match[1]
                    if (baseCheckpointDate === today) {
                        logger.debug(`[AI-Plugin] 用户 ${userId} 今天已创建过锚点，跳过`)
                        return
                    }
                    baseCheckpointContent = fs.readFileSync(path.join(CHECKPOINT_DIR, latestFile), 'utf8')
                }
            }
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

            let dayContent = ""
            for (const turn of dayHistory) {
                const role = turn.role === 'user' ? '用户' : '诺亚'
                const text = turn.parts.map(p => p.text).join(' ')
                if (text) dayContent += `${role}: ${text}\n`
            }

            if (!dayContent.trim()) continue

            let summaryText = ""

            // 优先从数据库获取摘要缓存
            const dbSummary = await global.AIPluginConversationManager.db.getSummaryCache(userId, dateDir)
            if (dbSummary) {
                summaryText = dbSummary.content
            } else {
                // 降级：从文件读取
                const cacheFile = path.join(SUMMARY_CACHE_DIR, dateDir, `${userIdStr}.txt`)
                if (fs.existsSync(cacheFile)) {
                    summaryText = fs.readFileSync(cacheFile, 'utf8')
                } else {
                    logger.debug(`[AI-Plugin] 为用户 ${userId} 生成 ${dateDir} 摘要...`)
                    const summaryPrompt = `
请将以下这段发生在【${dateDir}】的对话概括为一个简短的摘要（4096字以内）。
重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
直接输出摘要内容，不要加"好的"等客套话。
对话内容：
${dayContent}`

                    const payload = { "contents": [{ "role": "user", "parts": [{ "text": summaryPrompt }] }] }
                    const result = await this.client.makeRequest('chat', payload, 'default')

                    if (result.success) {
                        summaryText = result.data.trim()
                        // 同时保存到数据库和文件
                        await global.AIPluginConversationManager.db.saveSummaryCache(userId, summaryText, dateDir)
                        const cacheDir = path.join(SUMMARY_CACHE_DIR, dateDir)
                        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
                        fs.writeFileSync(cacheFile, summaryText, 'utf8')
                    } else {
                        logger.warn(`[AI-Plugin] ${dateDir} 摘要生成失败: ${result.error}`)
                        summaryText = `【${dateDir} 原始片段】: ${dayContent.slice(0, 500)}...`
                    }
                }
            }

            finalContext += `\n=== 📅 【${dateDir} 记忆摘要】 ===\n${summaryText}\n`
        }

        if (!finalContext.trim()) {
            logger.debug(`[AI-Plugin] 用户 ${userId} 没有可归档的记忆，跳过`)
            return
        }

        // 同时保存到数据库和文件
        await global.AIPluginConversationManager.db.saveCheckpoint(userId, finalContext, today)
        const newCheckpointFile = path.join(CHECKPOINT_DIR, `${userIdStr}_${today}.txt`)
        fs.writeFileSync(newCheckpointFile, finalContext, 'utf8')
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
        if (!fs.existsSync(SUMMARY_CACHE_DIR)) {
            fs.mkdirSync(SUMMARY_CACHE_DIR, { recursive: true })
        }
        if (!fs.existsSync(CHECKPOINT_DIR)) {
            fs.mkdirSync(CHECKPOINT_DIR, { recursive: true })
        }

        const userIdStr = String(userId)
        let finalContext = ""

        const dateDirs = await global.AIPluginConversationManager.db.getDistinctDates(userId)

        for (const dateDir of dateDirs) {
            const dayHistory = await global.AIPluginConversationManager.db.getConversationHistoryByDate(userId, dateDir)
            if (dayHistory.length === 0) continue

            let dayContent = ""
            for (const turn of dayHistory) {
                const role = turn.role === 'user' ? '用户' : '诺亚'
                const text = turn.parts.map(p => p.text).join(' ')
                if (text) dayContent += `${role}: ${text}\n`
            }

            if (!dayContent.trim()) continue

            let summaryText = ""

            // 优先从数据库获取摘要缓存
            const dbSummary = await global.AIPluginConversationManager.db.getSummaryCache(userId, dateDir)
            if (dbSummary) {
                summaryText = dbSummary.content
            } else {
                // 降级：从文件读取
                const cacheFile = path.join(SUMMARY_CACHE_DIR, dateDir, `${userIdStr}.txt`)
                if (fs.existsSync(cacheFile)) {
                    summaryText = fs.readFileSync(cacheFile, 'utf8')
                } else {
                    logger.debug(`[AI-Plugin] 为用户 ${userId} 生成 ${dateDir} 摘要...`)
                    const summaryPrompt = `
请将以下这段发生在【${dateDir}】的对话概括为一个简短的摘要（4096字以内）。
重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
直接输出摘要内容，不要加"好的"等客套话。
对话内容：
${dayContent}`

                    const payload = { "contents": [{ "role": "user", "parts": [{ "text": summaryPrompt }] }] }
                    const result = await this.client.makeRequest('chat', payload, 'default')

                    if (result.success) {
                        summaryText = result.data.trim()
                        // 同时保存到数据库和文件
                        await global.AIPluginConversationManager.db.saveSummaryCache(userId, summaryText, dateDir)
                        const cacheDir = path.join(SUMMARY_CACHE_DIR, dateDir)
                        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
                        fs.writeFileSync(cacheFile, summaryText, 'utf8')
                    } else {
                        logger.warn(`[AI-Plugin] ${dateDir} 摘要生成失败: ${result.error}`)
                        summaryText = `【${dateDir} 原始片段】: ${dayContent.slice(0, 500)}...`
                    }
                }
            }

            finalContext += `\n=== 📅 【${dateDir} 记忆摘要】 ===\n${summaryText}\n`
        }

        if (!finalContext.trim()) {
            logger.debug(`[AI-Plugin] 用户 ${userId} 没有可归档的记忆，跳过`)
            return
        }

        // 同时保存到数据库和文件
        await global.AIPluginConversationManager.db.saveCheckpoint(userId, finalContext, today)
        const newCheckpointFile = path.join(CHECKPOINT_DIR, `${userIdStr}_${today}.txt`)
        fs.writeFileSync(newCheckpointFile, finalContext, 'utf8')
        logger.info(`[AI-Plugin] 为用户 ${userId} 创建全量锚点成功: ${today}`)
    }
}
