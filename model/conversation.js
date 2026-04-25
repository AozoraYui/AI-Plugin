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
        const status = this.db.getMigrationStatus()
        if (status.json_migrated) {
            logger.debug('[AI-Plugin] JSON 数据已迁移，跳过。')
            return
        }

        if (!fs.existsSync(this.HISTORY_DIR)) {
            logger.info('[AI-Plugin] 未找到旧的历史记录目录，无需迁移。')
            this.db.setMigrationStatus(true)
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

                        const entries = history.map(turn => ({
                            user_id: userId,
                            role: turn.role,
                            parts: JSON.stringify(turn.parts),
                            date_str: dateDir
                        }))

                        const insert = this.db.db.prepare(`
                            INSERT INTO conversations (user_id, role, parts, date_str)
                            VALUES (?, ?, ?, ?)
                        `)

                        const insertMany = this.db.db.transaction((items) => {
                            for (const item of items) {
                                insert.run(item.user_id, item.role, item.parts, item.date_str)
                            }
                        })

                        insertMany.run(entries)
                        migratedUsers++
                        migratedTurns += history.length
                    } catch (err) {
                        logger.warn(`[AI-Plugin] 迁移用户 ${userId} 的数据失败: ${err.message}`)
                    }
                }
            }

            this.db.setMigrationStatus(true)
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
            const history = this.db.getConversationHistory(userId)
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
            const today = getTodayDateStr()
            const todayFile = path.join(this.HISTORY_DIR, today, `${userId}.json`)
            if (fs.existsSync(todayFile)) {
                const fileContent = fs.readFileSync(todayFile, 'utf8')
                if (!fileContent.trim()) return []

                const historyFromFile = JSON.parse(fileContent)
                if (Array.isArray(historyFromFile)) {
                    const historyToCache = this.cloneHistoryForSaving(historyFromFile)
                    await redis.set(redisKey, JSON.stringify(historyToCache), { EX: weekInSeconds })
                    this.db.saveConversation(userId, historyFromFile)
                    logger.info(`[AI-Plugin] 已从今日 JSON 文件恢复并缓存用户 ${userId} 的记忆`)
                    return historyFromFile
                }
            }
        } catch (fileError) {
            logger.error(`[AI-Plugin] 从文件恢复用户 ${userId} 的历史失败:`, fileError)
        }

        return []
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
                const entry = {
                    user_id: String(userId),
                    role: lastTurn.role,
                    parts: JSON.stringify(lastTurn.parts),
                    date_str: dateStr
                }

                this.db.db.prepare(`
                    INSERT INTO conversations (user_id, role, parts, date_str)
                    VALUES (?, ?, ?, ?)
                `).run(entry.user_id, entry.role, entry.parts, entry.date_str)
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
            this.db.clearConversationHistory(userId)
            return true
        } catch (error) {
            logger.error(`[AI-Plugin] 重置对话历史失败:`, error)
            return false
        }
    }

    getUserProfile(userId) {
        const profile = this.db.getUserProfile(userId)
        if (profile) return profile

        const userProfileId = `private_${userId}`
        const localProfile = this.userProfiles.get(userProfileId)
        if (localProfile) {
            this.db.saveUserProfile(userId, localProfile.info)
            return localProfile
        }
        return null
    }

    async saveUserProfile(userId, info) {
        const userProfileId = `private_${userId}`
        this.userProfiles.set(userProfileId, { info, lastUpdated: new Date().toISOString() })
        this.saveUserProfiles()
        this.db.saveUserProfile(userId, info)
    }

    async deleteUserProfile(userId) {
        const userProfileId = `private_${userId}`
        let deleted = false

        if (this.userProfiles.has(userProfileId)) {
            this.userProfiles.delete(userProfileId)
            this.saveUserProfiles()
            deleted = true
        }

        if (this.db.deleteUserProfile(userId)) {
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
            const redisKey = `ai-plugin:history:${userId}`
            const value = await redis.get(redisKey)
            if (value) {
                try {
                    exportedData[userId] = JSON.parse(value)
                } catch (parseErr) {
                    logger.warn(`[AI-Plugin] 导出用户 ${userId} 的JSON失败。`)
                    return { success: false, message: "记忆文件损坏，导出失败" }
                }
            } else {
                const history = this.db.getConversationHistory(userId)
                if (history.length > 0) {
                    exportedData[userId] = history
                }
            }
        } else {
            const userIds = this.db.getAllUserIds()
            for (const uid of userIds) {
                const history = this.db.getConversationHistory(uid)
                if (history.length > 0) {
                    exportedData[uid] = history
                }
            }
        }

        if (Object.keys(exportedData).length === 0) {
            return { success: false, message: "没有找到任何记忆数据" }
        }

        const fileName = scope === 'single' ? `noa_memory_${userId}.json` : `noa_all_memory.json`
        const filePath = path.join(process.cwd(), 'data', 'ai_assistant', fileName)

        try {
            fs.writeFileSync(filePath, JSON.stringify(exportedData, null, 2), 'utf8')
            return { success: true, filePath, fileName }
        } catch (err) {
            logger.error(`[AI-Plugin] 保存记忆文件失败:`, err)
            return { success: false, message: "保存记忆文件失败" }
        }
    }
}
