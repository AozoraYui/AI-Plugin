import fs from 'node:fs'
import path from 'node:path'
import { USER_PROFILES_FILE, SUMMARY_CACHE_DIR, CHECKPOINT_DIR } from '../utils/config.js'
import { getTodayDateStr } from '../utils/common.js'

export class ConversationManager {
    constructor(HISTORY_DIR) {
        this.HISTORY_DIR = HISTORY_DIR
        this.userProfiles = new Map()
        this.loadUserProfiles()
        this.ensureHistoryDirExists()
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

    cloneHistoryForSaving(history) {
        const historyCopy = JSON.parse(JSON.stringify(history))
        for (const turn of historyCopy) {
            if (turn.parts) {
                turn.parts = turn.parts.filter(part => !part.inline_data)
            }
        }
        return historyCopy
    }

    findLatestHistoryFile(userId) {
        const userIdStr = String(userId)

        const today = getTodayDateStr()
        const todayFile = path.join(this.HISTORY_DIR, today, `${userIdStr}.json`)
        if (fs.existsSync(todayFile)) {
            return todayFile
        }

        if (fs.existsSync(this.HISTORY_DIR)) {
            try {
                const entries = fs.readdirSync(this.HISTORY_DIR)

                const dirs = entries.filter(name => {
                    const fullPath = path.join(this.HISTORY_DIR, name)
                    return /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(fullPath).isDirectory()
                })
                    .sort()
                    .reverse()

                for (const dateDir of dirs) {
                    const file = path.join(this.HISTORY_DIR, dateDir, `${userIdStr}.json`)
                    if (fs.existsSync(file)) {
                        logger.debug(`[AI-Plugin] 在历史目录 ${dateDir} 中找到用户 ${userIdStr} 的记忆。`)
                        return file
                    }
                }
            } catch (err) {
                logger.error(`[AI-Plugin] 遍历历史目录时出错: ${err.message}`)
            }
        }

        const legacyFile = path.join(this.HISTORY_DIR, `${userIdStr}.json`)
        if (fs.existsSync(legacyFile)) {
            return legacyFile
        }

        return null
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
            const historyFilePath = this.findLatestHistoryFile(userId)

            if (historyFilePath && fs.existsSync(historyFilePath)) {
                const fileContent = fs.readFileSync(historyFilePath, 'utf8')
                if (!fileContent.trim()) {
                    logger.warn(`[AI-Plugin] 用户 ${userId} 的记忆文件为空，已跳过。`)
                    return []
                }

                const historyFromFile = JSON.parse(fileContent)

                if (Array.isArray(historyFromFile)) {
                    const historyToCache = this.cloneHistoryForSaving(historyFromFile)
                    await redis.set(redisKey, JSON.stringify(historyToCache), { EX: weekInSeconds })

                    logger.info(`[AI-Plugin] 已从文件恢复并缓存用户 ${userId} 的记忆`)
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
            return true
        } catch (error) {
            logger.error(`[AI-Plugin] 重置对话历史失败:`, error)
            return false
        }
    }

    getUserProfile(userId) {
        const userProfileId = `private_${userId}`
        return this.userProfiles.get(userProfileId)
    }

    async saveUserProfile(userId, info) {
        const userProfileId = `private_${userId}`
        this.userProfiles.set(userProfileId, { info, lastUpdated: new Date().toISOString() })
        this.saveUserProfiles()
    }

    async deleteUserProfile(userId) {
        const userProfileId = `private_${userId}`
        if (this.userProfiles.has(userProfileId)) {
            this.userProfiles.delete(userProfileId)
            this.saveUserProfiles()
            return true
        }
        return false
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
            }
        } else {
            const keys = await redis.keys('ai-plugin:history:*')
            for (const key of keys) {
                const value = await redis.get(key)
                const uid = key.replace('ai-plugin:history:', '')
                if (value) {
                    try {
                        exportedData[uid] = JSON.parse(value)
                    } catch (parseErr) {
                        logger.warn(`[AI-Plugin] 导出用户 ${uid} 的JSON失败，已跳过。`)
                    }
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
