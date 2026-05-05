import fs from 'node:fs'
import path from 'node:path'
import { HISTORY_DIR, CHECKPOINT_DIR, SUMMARY_CACHE_DIR } from '../utils/config.js'
import { AIDatabase } from '../utils/database.js'
import { getTodayDateStr } from '../utils/common.js'

export class ConversationManager {
    constructor() {
        this.db = new AIDatabase()
        this._initPromise = this._initialize()
    }

    async _initialize() {
        await this.db.waitForReady()
        await this.migrateAllData()
    }

    async waitForMigration() {
        if (this._initPromise) {
            await this._initPromise
        }
    }

    async migrateAllData() {
        const migrationStatus = await this.db.getMigrationStatus()
        const checkpointsStatus = await this.db.getCheckpointsMigrationStatus()
        const summaryStatus = await this.db.getSummaryMigrationStatus()

        // 只有在需要迁移时才执行
        if (!migrationStatus.json_migrated || !checkpointsStatus || !summaryStatus) {
            // 迁移 JSON 数据
            if (!migrationStatus.json_migrated) {
                await this.migrateOldData()
            }
            
            // 迁移全量锚点
            if (!checkpointsStatus) {
                await this.migrateCheckpoints()
            }
            
            // 迁移增量锚点
            if (!summaryStatus) {
                await this.migrateSummaryCache()
            }
        }
    }

    async migrateOldData() {
        const status = await this.db.getMigrationStatus()
        if (status.json_migrated) {
            logger.debug('[AI-Plugin] JSON 数据已迁移，跳过。')
            return
        }

        if (!fs.existsSync(HISTORY_DIR)) {
            logger.info('[AI-Plugin] 未找到旧的历史记录目录，无需迁移。')
            await this.db.setMigrationStatus(true)
            return
        }

        logger.info('[AI-Plugin] 开始迁移旧 JSON 数据到 SQLite...')
        const migratedUserIds = new Set()
        let migratedTurns = 0

        try {
            const entries = fs.readdirSync(HISTORY_DIR)

            const dateDirs = entries.filter(name => {
                const fullPath = path.join(HISTORY_DIR, name)
                return /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(fullPath).isDirectory()
            })

            for (const dateDir of dateDirs) {
                const dirPath = path.join(HISTORY_DIR, dateDir)
                const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'))

                for (const file of files) {
                    const userId = file.replace('.json', '')
                    const filePath = path.join(dirPath, file)

                    try {
                        const content = fs.readFileSync(filePath, 'utf8')
                        if (!content.trim()) continue

                        const history = JSON.parse(content)
                        if (!Array.isArray(history)) continue

                        // 为每条对话添加目录中的日期
                        const historyWithDate = history.map(turn => ({
                            ...turn,
                            date_str: turn.date_str || dateDir
                        }))

                        await this.db.saveConversation(userId, historyWithDate)
                        migratedUserIds.add(userId)
                        migratedTurns += history.length
                    } catch (err) {
                        logger.warn(`[AI-Plugin] 迁移用户 ${userId} 的数据失败: ${err.message}`)
                    }
                }
            }

            await this.db.setMigrationStatus(true)
            logger.info(`[AI-Plugin] 迁移完成！共迁移 ${migratedUserIds.size} 个用户，${migratedTurns} 条对话。`)
            logger.info('[AI-Plugin] 旧 JSON 文件已保留，不会被删除。')
        } catch (error) {
            logger.error('[AI-Plugin] 迁移过程中出错:', error)
        }
    }

    async migrateCheckpoints() {
        const status = await this.db.getCheckpointsMigrationStatus()
        if (status) {
            logger.debug('[AI-Plugin] 全量锚点数据已迁移，跳过。')
            return
        }

        logger.info(`[AI-Plugin] 检查全量锚点目录: ${CHECKPOINT_DIR}`)
        logger.info(`[AI-Plugin] 目录存在: ${fs.existsSync(CHECKPOINT_DIR)}`)

        if (!fs.existsSync(CHECKPOINT_DIR)) {
            logger.info('[AI-Plugin] 未找到全量锚点目录，无需迁移。')
            await this.db.setCheckpointsMigrationStatus(true)
            return
        }

        logger.info('[AI-Plugin] 开始迁移全量锚点数据到 SQLite...')
        let migratedCount = 0

        try {
            const files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.txt'))

            for (const file of files) {
                // 文件名格式：用户ID_日期.txt
                const match = file.match(/^(\d+)_(\d{4}-\d{2}-\d{2})\.txt$/)
                if (!match) continue

                const userId = match[1]
                const dateStr = match[2]
                const filePath = path.join(CHECKPOINT_DIR, file)

                try {
                    const content = fs.readFileSync(filePath, 'utf8')
                    if (!content.trim()) continue

                    await this.db.saveCheckpoint(userId, content.trim(), dateStr)
                    migratedCount++
                } catch (err) {
                    logger.warn(`[AI-Plugin] 迁移全量锚点 ${file} 失败: ${err.message}`)
                }
            }

            await this.db.setCheckpointsMigrationStatus(true)
            logger.info(`[AI-Plugin] 全量锚点迁移完成！共迁移 ${migratedCount} 个锚点。`)
            logger.info('[AI-Plugin] 旧全量锚点文件已保留，不会被删除。')
        } catch (error) {
            logger.error('[AI-Plugin] 迁移全量锚点过程中出错:', error)
        }
    }

    async migrateSummaryCache() {
        const status = await this.db.getSummaryMigrationStatus()
        if (status) {
            logger.debug('[AI-Plugin] 增量锚点数据已迁移，跳过。')
            return
        }

        if (!fs.existsSync(SUMMARY_CACHE_DIR)) {
            logger.info('[AI-Plugin] 未找到增量锚点目录，无需迁移。')
            await this.db.setSummaryMigrationStatus(true)
            return
        }

        logger.info('[AI-Plugin] 开始迁移增量锚点数据到 SQLite...')
        let migratedCount = 0

        try {
            const dateDirs = fs.readdirSync(SUMMARY_CACHE_DIR).filter(name => {
                const fullPath = path.join(SUMMARY_CACHE_DIR, name)
                return /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(fullPath).isDirectory()
            })

            for (const dateDir of dateDirs) {
                const dirPath = path.join(SUMMARY_CACHE_DIR, dateDir)
                const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt'))

                for (const file of files) {
                    const userId = file.replace('.txt', '')
                    const filePath = path.join(dirPath, file)

                    try {
                        const content = fs.readFileSync(filePath, 'utf8')
                        if (!content.trim()) continue

                        await this.db.saveSummaryCache(userId, content.trim(), dateDir)
                        migratedCount++
                    } catch (err) {
                        logger.warn(`[AI-Plugin] 迁移增量锚点 ${dateDir}/${file} 失败: ${err.message}`)
                    }
                }
            }

            await this.db.setSummaryMigrationStatus(true)
            logger.info(`[AI-Plugin] 增量锚点迁移完成！共迁移 ${migratedCount} 个缓存。`)
            logger.info('[AI-Plugin] 旧增量锚点文件已保留，不会被删除。')
        } catch (error) {
            logger.error('[AI-Plugin] 迁移增量锚点过程中出错:', error)
        }
    }

    async fixMigrationDates() {
        logger.info('[AI-Plugin] 开始修复迁移日期...')
        
        // 重置迁移状态
        await this.db.setMigrationStatus(false)
        
        // 清空现有数据（因为日期都是错误的）
        await this.db.db.run('DELETE FROM user_histories')
        
        // 重新迁移
        await this.migrateOldData()
        
        logger.info('[AI-Plugin] 修复迁移日期完成！')
    }

    cloneHistoryForSaving(history) {
        const historyCopy = JSON.parse(JSON.stringify(history))
        for (const turn of historyCopy) {
            if (turn.parts) {
                turn.parts = turn.parts.filter(part => !part.inline_data)
            }
        }
        return historyCopy
    }

    async getUserHistory(userId) {
        const redisKey = `ai-plugin:history:${userId}`
        const weekInSeconds = 7 * 24 * 60 * 60

        try {
            const historyJson = await redis.get(redisKey)
            if (historyJson) {
                await redis.expire(redisKey, weekInSeconds)
                const data = JSON.parse(historyJson)
                if (Array.isArray(data)) return data
            }
        } catch (error) {
            logger.error(`[AI-Plugin] 从Redis读取用户 ${userId} 的历史失败:`, error)
        }

        try {
            const history = await this.db.getConversationHistory(userId)
            if (history.length > 0) {
                const historyToCache = this.cloneHistoryForSaving(history)
                await redis.set(redisKey, JSON.stringify(historyToCache), { EX: weekInSeconds })
                logger.debug(`[AI-Plugin] 已从 SQLite 恢复并缓存用户 ${userId} 的记忆`)
                return history
            }
        } catch (dbError) {
            logger.error(`[AI-Plugin] 从 SQLite 读取用户 ${userId} 的历史失败:`, dbError)
        }

        return []
    }

    async getUserHistoryWithCheckpoint(userId) {
        const userIdStr = String(userId)

        const latestSummary = await this.db.getLatestSummaryCache(userIdStr)
        let incrementalContent = ""
        if (latestSummary) {
            incrementalContent = latestSummary.content
        }

        let history = []

        try {
            history = await this.db.getConversationHistory(userIdStr)
        } catch (err) {
            logger.error(`[AI-Plugin] 从 SQLite 读取用户 ${userId} 的历史失败:`, err)
        }

        return { 
            incrementalCheckpoint: incrementalContent,
            history 
        }
    }

    async saveUserHistory(userId, history) {
        const redisKey = `ai-plugin:history:${userId}`
        const weekInSeconds = 7 * 24 * 60 * 60

        try {
            const historyToSave = this.cloneHistoryForSaving(history)
            await redis.set(redisKey, JSON.stringify(historyToSave), { EX: weekInSeconds })
        } catch (error) {
            logger.error(`[AI-Plugin] 保存用户 ${userId} 的历史到Redis失败:`, error)
        }

        try {
            const dateStr = getTodayDateStr()

            // 按日期分组保存完整历史到 SQLite
            // 对于从 Redis 加载的历史（没有 date_str），统一标记为今天
            // 对于从迁移加载的历史（有 date_str），保留原有日期
            const historyWithDate = history.map(turn => ({
                ...turn,
                date_str: turn.date_str || dateStr
            }))

            // 按日期分组
            const groupedByDate = {}
            for (const turn of historyWithDate) {
                const date = turn.date_str
                if (!groupedByDate[date]) {
                    groupedByDate[date] = []
                }
                groupedByDate[date].push(turn)
            }

            // 保存每个日期的对话到 SQLite
            for (const [date, dayHistory] of Object.entries(groupedByDate)) {
                await this.db.saveConversation(userId, dayHistory)
            }
        } catch (dbError) {
            logger.error(`[AI-Plugin] 持久化保存用户 ${userId} 的历史到SQLite失败:`, dbError)
        }
    }

    async resetChatHistory(userId) {
        try {
            const redisKey = `ai-plugin:history:${userId}`
            await redis.del(redisKey)
            await this.db.clearConversationHistory(userId)
            return true
        } catch (error) {
            logger.error(`[AI-Plugin] 重置对话历史失败:`, error)
            return false
        }
    }

    _ensureSummaryCacheDir() {
        if (!fs.existsSync(SUMMARY_CACHE_DIR)) {
            fs.mkdirSync(SUMMARY_CACHE_DIR, { recursive: true })
        }
    }

    _ensureCheckpointDir() {
        if (!fs.existsSync(CHECKPOINT_DIR)) {
            fs.mkdirSync(CHECKPOINT_DIR, { recursive: true })
        }
    }

    async exportMemory(e, userId, scope = 'single', dateStr = null) {
        const exportedData = {}

        if (scope === 'single') {
            const history = dateStr
                ? await this.db.getConversationHistoryByDate(userId, dateStr)
                : await this.db.getConversationHistory(userId)
            if (history.length > 0) {
                exportedData[userId] = history
            }
        } else {
            const userIds = dateStr
                ? await this.db.getAllUserIdsByDateRange(dateStr, dateStr)
                : await this.db.getAllUserIds()
            for (const uid of userIds) {
                const history = dateStr
                    ? await this.db.getConversationHistoryByDate(uid, dateStr)
                    : await this.db.getConversationHistory(uid)
                if (history.length > 0) {
                    exportedData[uid] = history
                }
            }
        }

        if (Object.keys(exportedData).length === 0) {
            const dateMsg = dateStr ? ` ${dateStr} 的` : ''
            return { success: false, message: `没有找到${dateMsg}记忆数据` }
        }

        const exportDir = path.join(process.cwd(), 'data', 'ai_assistant')
        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true })
        }

        const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19)
        const identifier = scope === 'single' ? userId : 'all'
        const dateSuffix = dateStr ? `_${dateStr}` : ''
        const fileName = `noa_memory_export_${identifier}${dateSuffix}_${timestamp}.json`
        const filePath = path.join(exportDir, fileName)

        try {
            fs.writeFileSync(filePath, JSON.stringify(exportedData, null, 2), 'utf8')
            return { success: true, filePath, fileName }
        } catch (err) {
            logger.error(`[AI-Plugin] 保存记忆文件失败:`, err)
            return { success: false, message: "保存记忆文件失败" }
        }
    }

    async createIncrementalCheckpoint(userId, today, messageCount = 0, modelGroupKey = 'flash') {
        if (!global.AIPluginScheduler) {
            logger.error('[AI-Plugin] 定时任务未初始化，无法创建增量总结')
            return
        }
        await global.AIPluginScheduler._createIncrementalCheckpoint(userId, today, messageCount, modelGroupKey)
    }
}
