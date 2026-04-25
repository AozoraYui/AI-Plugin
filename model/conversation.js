import fs from 'node:fs'
import path from 'node:path'
import { USER_PROFILES_FILE, SUMMARY_CACHE_DIR, CHECKPOINT_DIR, HISTORY_DIR } from '../utils/config.js'
import { AIDatabase } from '../utils/database.js'
import { getTodayDateStr } from '../utils/common.js'

export class ConversationManager {
    constructor() {
        this.db = new AIDatabase()
        this.HISTORY_DIR = HISTORY_DIR
        this.userProfiles = new Map()
        this.loadUserProfiles()
        this.ensureHistoryDirExists()
        this.migrateOldData()
    }

    loadUserProfiles() {
        try {
            if (fs.existsSync(USER_PROFILES_FILE)) {
                const data = fs.readFileSync(USER_PROFILES_FILE, 'utf8')
                this.userProfiles = new Map(JSON.parse(data))
                logger.info(`[AI-Plugin] 成功加载 ${this.userProfiles.size} 条用户档案。`)
            }
        } catch (err) {
            logger.error('[AI-Plugin] 加载用户档案失败:', err)
        }
    }

    saveUserProfiles() {
        try {
            const data = JSON.stringify(Array.from(this.userProfiles.entries()), null, 2)
            fs.writeFileSync(USER_PROFILES_FILE, data, 'utf8')
        } catch (err) {
            logger.error('[AI-Plugin] 保存用户档案失败:', err)
        }
    }

    ensureHistoryDirExists() {
        try {
            if (!fs.existsSync(this.HISTORY_DIR)) {
                fs.mkdirSync(this.HISTORY_DIR, { recursive: true })
                logger.info(`[AI-Plugin] 用户历史记录目录已创建于: ${this.HISTORY_DIR}`)
            }
        } catch (error) {
            logger.error(`[AI-Plugin] 创建用户历史记录目录失败:`, error)
        }
    }

    async migrateOldData() {
        const status = await this.db.getMigrationStatus()
        if (status.json_migrated) {
            logger.debug('[AI-Plugin] JSON 数据已迁移，跳过。')
            return
        }

        if (!fs.existsSync(this.HISTORY_DIR)) {
            logger.info('[AI-Plugin] 未找到旧的历史记录目录，无需迁移。')
            await this.db.setMigrationStatus(true)
            return
        }

        logger.info('[AI-Plugin] 开始迁移旧 JSON 数据到 SQLite...')
        let migratedUsers = 0
        let migratedTurns = 0

        try {
            const entries = fs.readdirSync(this.HISTORY_DIR)

            const dateDirs = entries.filter(name => {
                const fullPath = path.join(this.HISTORY_DIR, name)
                return /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(fullPath).isDirectory()
            })

            for (const dateDir of dateDirs) {
                const dirPath = path.join(this.HISTORY_DIR, dateDir)
                const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'))

                for (const file of files) {
                    const userId = file.replace('.json', '')
                    const filePath = path.join(dirPath, file)

                    try {
                        const content = fs.readFileSync(filePath, 'utf8')
                        if (!content.trim()) continue

                        const history = JSON.parse(content)
                        if (!Array.isArray(history)) continue

                        await this.db.saveConversation(userId, history)
                        migratedUsers++
                        migratedTurns += history.length
                    } catch (err) {
                        logger.warn(`[AI-Plugin] 迁移用户 ${userId} 的数据失败: ${err.message}`)
                    }
                }
            }

            await this.db.setMigrationStatus(true)
            logger.info(`[AI-Plugin] 迁移完成！共迁移 ${migratedUsers} 个用户，${migratedTurns} 条对话。`)
            logger.info('[AI-Plugin] 旧 JSON 文件已保留，不会被删除。')
        } catch (error) {
            logger.error('[AI-Plugin] 迁移过程中出错:', error)
        }
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
        const today = getTodayDateStr()

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

        try {
            const todayFile = path.join(this.HISTORY_DIR, today, `${userId}.json`)
            if (fs.existsSync(todayFile)) {
                const fileContent = fs.readFileSync(todayFile, 'utf8')
                if (!fileContent.trim()) return []

                const historyFromFile = JSON.parse(fileContent)
                if (Array.isArray(historyFromFile)) {
                    const historyToCache = this.cloneHistoryForSaving(historyFromFile)
                    await redis.set(redisKey, JSON.stringify(historyToCache), { EX: weekInSeconds })
                    await this.db.saveConversation(userId, historyFromFile)
                    logger.info(`[AI-Plugin] 已从今日 JSON 文件恢复并缓存用户 ${userId} 的记忆`)
                    return historyFromFile
                }
            }
        } catch (fileError) {
            logger.error(`[AI-Plugin] 从文件恢复用户 ${userId} 的历史失败:`, fileError)
        }

        return []
    }

    async getUserHistoryWithCheckpoint(userId) {
        const userIdStr = String(userId)
        const today = getTodayDateStr()

        const files = fs.readdirSync(CHECKPOINT_DIR)
            .filter(name => name.startsWith(`${userIdStr}_`) && name.endsWith('.txt'))
            .sort()
            .reverse()

        let fullCheckpointDate = null
        let fullCheckpointContent = ""

        for (const file of files) {
            const match = file.match(/_(\d{4}-\d{2}-\d{2})\.txt$/)
            if (match) {
                const date = match[1]
                if (date !== today) {
                    fullCheckpointDate = date
                    fullCheckpointContent = fs.readFileSync(path.join(CHECKPOINT_DIR, file), 'utf8')
                    break
                }
            }
        }

        let history = []

        try {
            history = await this.db.getConversationHistoryByDateRange(userId, fullCheckpointDate, null)
        } catch (err) {
            logger.error(`[AI-Plugin] 从 SQLite 读取用户 ${userId} 的历史失败:`, err)
        }

        return { checkpoint: fullCheckpointContent, history }
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
            const lastTurn = history[history.length - 1]
            if (lastTurn) {
                const dateStr = getTodayDateStr()
                await this.db.saveConversationEntry(userId, lastTurn.role, lastTurn.parts, dateStr)
            }

            const dateStr = getTodayDateStr()
            const dateDir = path.join(this.HISTORY_DIR, dateStr)

            if (!fs.existsSync(dateDir)) {
                fs.mkdirSync(dateDir, { recursive: true })
            }

            const historyFilePath = path.join(dateDir, `${userId}.json`)
            fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2), 'utf8')
        } catch (fileError) {
            logger.error(`[AI-Plugin] 持久化保存用户 ${userId} 的历史到文件失败:`, fileError)
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

    async getUserProfile(userId) {
        const profile = await this.db.getUserProfile(userId)
        if (profile) return profile

        const userProfileId = `private_${userId}`
        const localProfile = this.userProfiles.get(userProfileId)
        if (localProfile) {
            await this.db.saveUserProfile(userId, localProfile.info)
            return localProfile
        }
        return null
    }

    async saveUserProfile(userId, info) {
        const userProfileId = `private_${userId}`
        this.userProfiles.set(userProfileId, { info, lastUpdated: new Date().toISOString() })
        this.saveUserProfiles()
        await this.db.saveUserProfile(userId, info)
    }

    async deleteUserProfile(userId) {
        const userProfileId = `private_${userId}`
        let deleted = false

        if (this.userProfiles.has(userProfileId)) {
            this.userProfiles.delete(userProfileId)
            this.saveUserProfiles()
            deleted = true
        }

        if (await this.db.deleteUserProfile(userId)) {
            deleted = true
        }

        return deleted
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

    async exportMemory(e, userId, scope = 'single') {
        const exportedData = {}

        if (scope === 'single') {
            const history = await this.db.getConversationHistory(userId)
            if (history.length > 0) {
                exportedData[userId] = history
            }
        } else {
            const userIds = await this.db.getAllUserIds()
            for (const uid of userIds) {
                const history = await this.db.getConversationHistory(uid)
                if (history.length > 0) {
                    exportedData[uid] = history
                }
            }
        }

        if (Object.keys(exportedData).length === 0) {
            return { success: false, message: "没有找到任何记忆数据" }
        }

        const exportDir = path.join(process.cwd(), 'data', 'ai_assistant')
        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true })
        }

        const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19)
        const identifier = scope === 'single' ? userId : 'all'
        const fileName = `noa_memory_export_${identifier}_${timestamp}.json`
        const filePath = path.join(exportDir, fileName)

        try {
            fs.writeFileSync(filePath, JSON.stringify(exportedData, null, 2), 'utf8')
            return { success: true, filePath, fileName }
        } catch (err) {
            logger.error(`[AI-Plugin] 保存记忆文件失败:`, err)
            return { success: false, message: "保存记忆文件失败" }
        }
    }
}
