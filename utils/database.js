import fs from 'node:fs'
import path from 'node:path'
import sqlite3 from 'sqlite3'
import { getDBTimestamp, ensureDir } from './common.js'

const _path = process.cwd()
const PLUGIN_DIR = path.join(_path, 'plugins', 'AI-Plugin')
const DATA_DIR = path.join(PLUGIN_DIR, 'data', 'database')
const LEGACY_DB_DIRS = [
    path.join(PLUGIN_DIR, 'config'),
    path.join(_path, 'data', 'ai_assistant')
]
const LEGACY_DB_FILES = ['ai_plugin.db', 'ai_assistant.db']

export const DB_FILE = path.join(DATA_DIR, 'ai_plugin.db')

function moveFileSync(from, to) {
    try {
        fs.renameSync(from, to)
    } catch (err) {
        if (err.code !== 'EXDEV') throw err
        fs.copyFileSync(from, to)
        fs.unlinkSync(from)
    }
}

function migrateLegacyDatabase() {
    ensureDir(DATA_DIR)

    if (fs.existsSync(DB_FILE)) return

    for (const legacyDir of LEGACY_DB_DIRS) {
        for (const legacyName of LEGACY_DB_FILES) {
            const legacyFile = path.join(legacyDir, legacyName)
            if (!fs.existsSync(legacyFile)) continue

            try {
                const suffixes = ['', '-wal', '-shm']
                for (const suffix of suffixes) {
                    const from = legacyFile + suffix
                    if (!fs.existsSync(from)) continue
                    const to = DB_FILE + suffix
                    moveFileSync(from, to)
                }
                logger.info(`[AI-Plugin] 已迁移 SQLite 数据库到新目录: ${DB_FILE}`)
                return
            } catch (err) {
                logger.error(`[AI-Plugin] 迁移旧 SQLite 数据库失败: ${err.message}`)
                return
            }
        }
    }
}

export class AIDatabase {
    constructor() {
        migrateLegacyDatabase()
        this.db = new sqlite3.Database(DB_FILE)
        this.db.run('PRAGMA journal_mode = WAL')
        this.db.run('PRAGMA foreign_keys = ON')
        this.db.run('PRAGMA wal_autocheckpoint = 1000')
        this._initPromise = this.initTables()
    }

    async waitForReady() {
        await this._initPromise
    }

    initTables() {
        return new Promise((resolve, reject) => {
            this.db.exec(`
                -- 全量锚点表（对应 memory_checkpoints/用户_日期.txt）
                CREATE TABLE IF NOT EXISTS memory_checkpoints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    date_str TEXT NOT NULL,
                    message_count INTEGER DEFAULT 0,
                    checkpoint_type TEXT DEFAULT 'incremental',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, date_str)
                );

                CREATE INDEX IF NOT EXISTS idx_checkpoints_user_date 
                ON memory_checkpoints(user_id, date_str);

                -- 增量锚点表（对应 summary_cache/日期/用户.txt）
                CREATE TABLE IF NOT EXISTS summary_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    date_str TEXT NOT NULL,
                    base_checkpoint_date TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, date_str)
                );

                CREATE INDEX IF NOT EXISTS idx_summary_user_date 
                ON summary_cache(user_id, date_str);

                -- 群聊流水表（畅聊模式使用，仅存文本化内容与图片元信息，不存图片本体）
                CREATE TABLE IF NOT EXISTS group_message_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id TEXT NOT NULL,
                    message_id TEXT,
                    seq TEXT,
                    user_id TEXT NOT NULL,
                    nickname TEXT,
                    normalized_text TEXT NOT NULL,
                    image_meta TEXT,
                    is_command BOOLEAN DEFAULT 0,
                    is_bot BOOLEAN DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(group_id, message_id)
                );

                CREATE INDEX IF NOT EXISTS idx_group_logs_group_created
                ON group_message_logs(group_id, created_at);

                CREATE INDEX IF NOT EXISTS idx_group_logs_group_user
                ON group_message_logs(group_id, user_id);

                -- 群成员称呼/外号记忆（来自本群公开聊天，不作为事实断言）
                CREATE TABLE IF NOT EXISTS group_member_aliases (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id TEXT NOT NULL,
                    target_user_id TEXT NOT NULL,
                    alias TEXT NOT NULL,
                    source_user_id TEXT,
                    source_nickname TEXT,
                    note TEXT,
                    is_joke BOOLEAN DEFAULT 1,
                    confidence REAL DEFAULT 0.6,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(group_id, target_user_id, alias)
                );

                CREATE INDEX IF NOT EXISTS idx_group_aliases_group_target
                ON group_member_aliases(group_id, target_user_id);

                CREATE INDEX IF NOT EXISTS idx_group_aliases_group_alias
                ON group_member_aliases(group_id, alias);

                -- 用户档案表
                CREATE TABLE IF NOT EXISTS user_profiles (
                    user_id TEXT PRIMARY KEY,
                    info TEXT NOT NULL,
                    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                -- 迁移状态表
                CREATE TABLE IF NOT EXISTS migration_status (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    json_migrated BOOLEAN DEFAULT 0,
                    checkpoints_migrated BOOLEAN DEFAULT 0,
                    summary_migrated BOOLEAN DEFAULT 0,
                    migration_time DATETIME
                );
            `, (err) => {
                if (err) {
                    reject(err)
                    return
                }

                // 为已存在的表添加 checkpoint_type 字段（如果不存在）
                this.db.run(`ALTER TABLE memory_checkpoints ADD COLUMN checkpoint_type TEXT DEFAULT 'incremental'`, (alterErr) => {
                    // 忽略字段已存在的错误
                    if (alterErr && alterErr.message && !alterErr.message.includes('duplicate column')) {
                        logger.debug('[AI-Plugin] checkpoint_type 字段迁移:', alterErr.message)
                    }

                    // 将所有现有记录的 checkpoint_type 设置为 'incremental'（兼容旧数据）
                    this.db.run(`UPDATE memory_checkpoints SET checkpoint_type = 'incremental' WHERE checkpoint_type IS NULL`, (updateErr) => {
                        if (updateErr) {
                            logger.debug('[AI-Plugin] checkpoint_type 数据迁移:', updateErr.message)
                        }

                        // 为 summary_cache 表添加 base_checkpoint_date 字段（如果不存在）
                        this.db.run(`ALTER TABLE summary_cache ADD COLUMN base_checkpoint_date TEXT`, (summaryAlterErr) => {
                            if (summaryAlterErr && summaryAlterErr.message && !summaryAlterErr.message.includes('duplicate column')) {
                                logger.debug('[AI-Plugin] base_checkpoint_date 字段迁移:', summaryAlterErr.message)
                            }

                            // 检查表状态并处理
                            this.checkAndCreateUserHistoriesTable(resolve, reject)
                        })
                    })
                })
            })
        })
    }

    checkAndCreateUserHistoriesTable(resolve, reject) {
        // 检查 user_histories 和 conversations 表是否存在
        this.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user_histories', 'conversations')", (err, rows) => {
            if (err) {
                reject(err)
                return
            }

            const tableNames = rows.map(r => r.name)
            const hasUserHistories = tableNames.includes('user_histories')
            const hasConversations = tableNames.includes('conversations')

            if (hasUserHistories) {
                // user_histories 已存在，直接使用
                this.initMigrationStatus(resolve, reject)
            } else if (hasConversations) {
                // 只有 conversations，重命名为 user_histories
                this.db.run('ALTER TABLE conversations RENAME TO user_histories', (err) => {
                    if (err) {
                        logger.error('[AI-Plugin] 重命名旧表失败:', err.message)
                        reject(err)
                        return
                    }
                    logger.info('[AI-Plugin] 已将 conversations 表重命名为 user_histories')
                    this.initMigrationStatus(resolve, reject)
                })
            } else {
                // 两个表都不存在，创建 user_histories
                this.db.exec(`
                    CREATE TABLE user_histories (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id TEXT NOT NULL,
                        role TEXT NOT NULL,
                        parts TEXT NOT NULL,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        date_str TEXT NOT NULL
                    );

                    CREATE INDEX idx_user_histories_user_date 
                    ON user_histories(user_id, date_str);

                    CREATE INDEX idx_user_histories_user_id 
                    ON user_histories(user_id);
                `, (err) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    this.initMigrationStatus(resolve, reject)
                })
            }
        })
    }

    initMigrationStatus(resolve, reject) {
        this.db.get('SELECT json_migrated FROM migration_status WHERE id = 1', (err, row) => {
            if (err || !row) {
                this.db.run('INSERT INTO migration_status (id, json_migrated, checkpoints_migrated, summary_migrated) VALUES (1, 0, 0, 0)', (err) => {
                    if (err) reject(err)
                    else resolve()
                })
            } else {
                // 修复旧数据的 created_at，使其跟随 date_str 的日期（使用中午 12 点作为默认时间）
                this.db.run("UPDATE user_histories SET created_at = date_str || ' 12:00:00' WHERE created_at IS NULL OR strftime('%Y-%m-%d', created_at) != date_str", (err) => {
                    if (err) {
                        // 忽略更新错误
                    }
                    // 添加 message_count 列（如果不存在）
                    this.db.run('ALTER TABLE memory_checkpoints ADD COLUMN message_count INTEGER DEFAULT 0', () => {
                        resolve()
                    })
                })
            }
        })
    }

    getConversationHistory(userId) {
        return new Promise((resolve, reject) => {
            const userIdStr = String(userId)
            this.db.all('SELECT role, parts, date_str FROM user_histories WHERE user_id = ? ORDER BY id ASC', [userIdStr], (err, rows) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(rows.map(row => ({
                    role: row.role,
                    parts: JSON.parse(row.parts),
                    date_str: row.date_str
                })))
            })
        })
    }

    saveConversation(userId, history) {
        return new Promise((resolve, reject) => {
            const userIdStr = String(userId)
            
            // 获取日期（从第一条对话中获取）
            const dateStr = history.length > 0 && history[0].date_str 
                ? history[0].date_str 
                : new Date().toISOString().split('T')[0]

            logger.debug(`[AI-Plugin] 保存用户 ${userId} 的 ${history.length} 条对话到 SQLite，日期: ${dateStr}`)

            // 先删除该用户该日期的旧数据
            this.db.run('DELETE FROM user_histories WHERE user_id = ? AND date_str = ?', [userIdStr, dateStr], (err) => {
                if (err) {
                    logger.error(`[AI-Plugin] 删除用户 ${userId} 的旧数据失败:`, err)
                    reject(err)
                    return
                }
                
                if (history.length === 0) {
                    logger.debug(`[AI-Plugin] 没有数据需要保存，跳过插入`)
                    resolve()
                    return
                }
                
                logger.debug(`[AI-Plugin] 已删除用户 ${userId} 在 ${dateStr} 的旧数据，准备插入 ${history.length} 条新数据`)
                
                // 再插入新的完整历史
                const insert = this.db.prepare(`
                    INSERT INTO user_histories (user_id, role, parts, date_str)
                    VALUES (?, ?, ?, ?)
                `)
                
                try {
                    this.db.serialize(() => {
                        this.db.run('BEGIN TRANSACTION')
                        
                        for (const turn of history) {
                            insert.run(
                                userIdStr,
                                turn.role,
                                JSON.stringify(turn.parts),
                                turn.date_str || dateStr
                            )
                        }
                        
                        this.db.run('COMMIT', (err) => {
                            insert.finalize()
                            if (err) {
                                logger.error(`[AI-Plugin] 提交事务失败:`, err)
                                reject(err)
                            } else {
                                logger.debug(`[AI-Plugin] 成功保存用户 ${userId} 的 ${history.length} 条对话`)
                                resolve()
                            }
                        })
                    })
                } catch (err) {
                    insert.finalize()
                    logger.error(`[AI-Plugin] 插入数据时出错:`, err)
                    reject(err)
                }
            })
        })
    }

    saveConversationEntry(userId, role, parts, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO user_histories (user_id, role, parts, date_str)
                VALUES (?, ?, ?, ?)
            `, [String(userId), role, JSON.stringify(parts), dateStr], (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    saveGroupMessageLog(log) {
        return new Promise((resolve, reject) => {
            const createdAt = log.createdAt || getDBTimestamp()
            this.db.run(`
                INSERT OR IGNORE INTO group_message_logs
                    (group_id, message_id, seq, user_id, nickname, normalized_text, image_meta, is_command, is_bot, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                String(log.groupId),
                log.messageId ? String(log.messageId) : null,
                log.seq ? String(log.seq) : null,
                String(log.userId),
                log.nickname || '',
                log.normalizedText || '',
                JSON.stringify(log.imageMeta || []),
                log.isCommand ? 1 : 0,
                log.isBot ? 1 : 0,
                createdAt
            ], function(err) {
                if (err) {
                    reject(err)
                    return
                }
                resolve(this.changes || 0)
            })
        })
    }

    getRecentGroupMessageLogs(groupId, limit = 60, options = {}) {
        return new Promise((resolve, reject) => {
            const params = [String(groupId)]
            let query = `
                SELECT group_id, message_id, seq, user_id, nickname, normalized_text, image_meta, is_command, is_bot, created_at
                FROM group_message_logs
                WHERE group_id = ?
            `
            if (options.excludeCommands === true) {
                query += ' AND is_command = 0'
            }
            query += ' ORDER BY id DESC LIMIT ?'
            params.push(Math.max(1, Number(limit) || 60))

            this.db.all(query, params, (err, rows) => {
                if (err) {
                    reject(err)
                    return
                }
                const normalized = rows.reverse().map(row => ({
                    groupId: row.group_id,
                    messageId: row.message_id,
                    seq: row.seq,
                    userId: row.user_id,
                    nickname: row.nickname,
                    normalizedText: row.normalized_text,
                    imageMeta: (() => {
                        try { return JSON.parse(row.image_meta || '[]') } catch { return [] }
                    })(),
                    isCommand: row.is_command === 1,
                    isBot: row.is_bot === 1,
                    createdAt: row.created_at
                }))
                resolve(normalized)
            })
        })
    }

    saveGroupMemberAlias(record) {
        return new Promise((resolve, reject) => {
            const updatedAt = getDBTimestamp()
            this.db.run(`
                INSERT INTO group_member_aliases
                    (group_id, target_user_id, alias, source_user_id, source_nickname, note, is_joke, confidence, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(group_id, target_user_id, alias) DO UPDATE SET
                    source_user_id = excluded.source_user_id,
                    source_nickname = excluded.source_nickname,
                    note = excluded.note,
                    is_joke = excluded.is_joke,
                    confidence = excluded.confidence,
                    updated_at = excluded.updated_at
            `, [
                String(record.groupId),
                String(record.targetUserId),
                String(record.alias || '').trim(),
                record.sourceUserId ? String(record.sourceUserId) : '',
                record.sourceNickname || '',
                record.note || '',
                record.isJoke ? 1 : 0,
                Number(record.confidence) || 0.6,
                updatedAt,
                updatedAt
            ], function(err) {
                if (err) {
                    reject(err)
                    return
                }
                resolve(this.changes || 0)
            })
        })
    }

    getGroupMemberAliases(groupId, targetUserIds = [], options = {}) {
        return new Promise((resolve, reject) => {
            const params = [String(groupId)]
            let query = `
                SELECT group_id, target_user_id, alias, source_user_id, source_nickname, note, is_joke, confidence, created_at, updated_at
                FROM group_member_aliases
                WHERE group_id = ?
            `
            const ids = Array.isArray(targetUserIds)
                ? [...new Set(targetUserIds.map(id => String(id)).filter(Boolean))]
                : (targetUserIds ? [String(targetUserIds)] : [])
            if (ids.length > 0) {
                query += ` AND target_user_id IN (${ids.map(() => '?').join(',')})`
                params.push(...ids)
            }
            query += ' ORDER BY updated_at DESC, id DESC LIMIT ?'
            params.push(Math.min(Math.max(Number(options.limit) || 50, 1), 200))

            this.db.all(query, params, (err, rows) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(rows.map(row => ({
                    groupId: row.group_id,
                    targetUserId: row.target_user_id,
                    alias: row.alias,
                    sourceUserId: row.source_user_id,
                    sourceNickname: row.source_nickname,
                    note: row.note,
                    isJoke: row.is_joke === 1,
                    confidence: row.confidence,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at
                })))
            })
        })
    }

    findGroupMemberAliases(groupId, query = '', options = {}) {
        return new Promise((resolve, reject) => {
            const params = [String(groupId)]
            let sql = `
                SELECT group_id, target_user_id, alias, source_user_id, source_nickname, note, is_joke, confidence, created_at, updated_at
                FROM group_member_aliases
                WHERE group_id = ?
            `
            const q = String(query || '').trim()
            if (q) {
                const like = `%${q}%`
                sql += ' AND (alias LIKE ? OR target_user_id LIKE ? OR source_user_id LIKE ? OR source_nickname LIKE ? OR note LIKE ?)'
                params.push(like, like, like, like, like)
            }
            sql += ' ORDER BY updated_at DESC, id DESC LIMIT ?'
            params.push(Math.min(Math.max(Number(options.limit) || 50, 1), 200))

            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(rows.map(row => ({
                    groupId: row.group_id,
                    targetUserId: row.target_user_id,
                    alias: row.alias,
                    sourceUserId: row.source_user_id,
                    sourceNickname: row.source_nickname,
                    note: row.note,
                    isJoke: row.is_joke === 1,
                    confidence: row.confidence,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at
                })))
            })
        })
    }

    clearConversationHistory(userId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM user_histories WHERE user_id = ?', [String(userId)], (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    getUserMessageCount(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT COUNT(*) as count FROM user_histories WHERE user_id = ?', [String(userId)], (err, row) => {
                if (err) reject(err)
                else resolve(row ? row.count : 0)
            })
        })
    }

    getTodayMessageCount(userId, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT COUNT(*) as count FROM user_histories WHERE user_id = ? AND date_str = ?', [String(userId), dateStr], (err, row) => {
                if (err) reject(err)
                else resolve(row ? row.count : 0)
            })
        })
    }

    getUserProfile(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT info, last_updated FROM user_profiles WHERE user_id = ?', [String(userId)], (err, row) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(row ? { info: row.info, lastUpdated: row.last_updated } : null)
            })
        })
    }

    saveUserProfile(userId, info) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO user_profiles (user_id, info, last_updated)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET info = ?, last_updated = CURRENT_TIMESTAMP
            `, [String(userId), info, info], (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    deleteUserProfile(userId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM user_profiles WHERE user_id = ?', [String(userId)], function(err) {
                if (err) {
                    reject(err)
                    return
                }
                resolve(this.changes > 0)
            })
        })
    }

    getAllUserIds() {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT DISTINCT user_id FROM user_histories', [], (err, rows) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(rows.map(row => row.user_id))
            })
        })
    }

    getConversationHistoryByDateRange(userId, startDate, endDate) {
        return new Promise((resolve, reject) => {
            const userIdStr = String(userId)
            let query = 'SELECT role, parts, date_str FROM user_histories WHERE user_id = ?'
            const params = [userIdStr]

            if (startDate) {
                query += ' AND date_str > ?'
                params.push(startDate)
            }
            if (endDate) {
                query += ' AND date_str <= ?'
                params.push(endDate)
            }

            query += ' ORDER BY id ASC'

            this.db.all(query, params, (err, rows) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(rows.map(row => ({
                    role: row.role,
                    parts: JSON.parse(row.parts),
                    date_str: row.date_str
                })))
            })
        })
    }

    getConversationHistoryByDate(userId, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT role, parts FROM user_histories WHERE user_id = ? AND date_str = ? ORDER BY id ASC',
                [String(userId), dateStr], (err, rows) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(rows.map(row => ({
                        role: row.role,
                        parts: JSON.parse(row.parts)
                    })))
                })
        })
    }

    getAllUserIdsByDateRange(startDate, endDate) {
        return new Promise((resolve, reject) => {
            let query = 'SELECT DISTINCT user_id FROM user_histories WHERE 1=1'
            const params = []

            if (startDate) {
                query += ' AND date_str >= ?'
                params.push(startDate)
            }
            if (endDate) {
                query += ' AND date_str <= ?'
                params.push(endDate)
            }

            this.db.all(query, params, (err, rows) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(rows.map(row => row.user_id))
            })
        })
    }

    getDistinctDates(userId) {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT DISTINCT date_str FROM user_histories WHERE user_id = ? ORDER BY date_str ASC',
                [String(userId)], (err, rows) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(rows.map(row => row.date_str))
                })
        })
    }

    getMigrationStatus() {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT json_migrated, migration_time FROM migration_status WHERE id = 1', (err, row) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(row || { json_migrated: false, migration_time: null })
            })
        })
    }

    setMigrationStatus(migrated) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                UPDATE migration_status 
                SET json_migrated = ?, migration_time = CURRENT_TIMESTAMP 
                WHERE id = 1
            `, [migrated ? 1 : 0], (err) => {
                if (err) reject(err)
                else {
                    // 强制 WAL checkpoint 确保数据持久化到主数据库文件
                    this.db.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
                        if (err) reject(err)
                        else resolve()
                    })
                }
            })
        })
    }

    // ========== 全量锚点方法（对应 memory_checkpoints/用户_日期.txt） ==========

    saveCheckpoint(userId, content, dateStr, messageCount = 0, checkpointType = 'incremental') {
        return new Promise((resolve, reject) => {
            const createdAt = getDBTimestamp()
            this.db.run(`
                INSERT INTO memory_checkpoints (user_id, content, date_str, message_count, checkpoint_type, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, date_str) DO UPDATE SET content = ?, message_count = ?, checkpoint_type = ?, created_at = ?
            `, [String(userId), content, dateStr, messageCount, checkpointType, createdAt, content, messageCount, checkpointType, createdAt], (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    getCheckpoint(userId, dateStr, checkpointType = null) {
        return new Promise((resolve, reject) => {
            let query = 'SELECT content, message_count, checkpoint_type, created_at FROM memory_checkpoints WHERE user_id = ? AND date_str = ?'
            let params = [String(userId), dateStr]
            if (checkpointType) {
                query += ' AND checkpoint_type = ?'
                params.push(checkpointType)
            }
            this.db.get(query, params, (err, row) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(row ? { content: row.content, messageCount: row.message_count, checkpointType: row.checkpoint_type, createdAt: row.created_at } : null)
            })
        })
    }

    getLatestCheckpoint(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT content, date_str, message_count, created_at, checkpoint_type FROM memory_checkpoints WHERE user_id = ? ORDER BY date_str DESC LIMIT 1',
                [String(userId)], (err, row) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(row ? { content: row.content, dateStr: row.date_str, messageCount: row.message_count, createdAt: row.created_at, checkpointType: row.checkpoint_type } : null)
                })
        })
    }

    getLatestFullCheckpoint(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT content, date_str, message_count, created_at FROM memory_checkpoints WHERE user_id = ? AND checkpoint_type = ? ORDER BY date_str DESC LIMIT 1',
                [String(userId), 'full'], (err, row) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(row ? { content: row.content, dateStr: row.date_str, messageCount: row.message_count, createdAt: row.created_at } : null)
                })
        })
    }

    getFullCheckpointByDate(userId, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT content, date_str, message_count, created_at FROM memory_checkpoints WHERE user_id = ? AND date_str = ? AND checkpoint_type = ?',
                [String(userId), dateStr, 'full'], (err, row) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(row ? { content: row.content, dateStr: row.date_str, messageCount: row.message_count, createdAt: row.created_at } : null)
                })
        })
    }

    getAllCheckpoints(userId) {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT content, date_str, created_at FROM memory_checkpoints WHERE user_id = ? ORDER BY date_str ASC',
                [String(userId)], (err, rows) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(rows.map(row => ({
                        content: row.content,
                        dateStr: row.date_str,
                        createdAt: row.created_at
                    })))
                })
        })
    }

    deleteCheckpoint(userId, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM memory_checkpoints WHERE user_id = ? AND date_str = ?',
                [String(userId), dateStr], (err) => {
                    if (err) reject(err)
                    else resolve()
                })
        })
    }

    // ========== 增量锚点方法（对应 summary_cache/日期/用户.txt） ==========

    saveSummaryCache(userId, content, dateStr, baseCheckpointDate = null) {
        return new Promise((resolve, reject) => {
            const createdAt = getDBTimestamp()
            this.db.run(`
                INSERT INTO summary_cache (user_id, content, date_str, base_checkpoint_date, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, date_str) DO UPDATE SET content = ?, base_checkpoint_date = ?, created_at = ?
            `, [String(userId), content, dateStr, baseCheckpointDate, createdAt, content, baseCheckpointDate, createdAt], (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    getSummaryCache(userId, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT content, created_at, base_checkpoint_date FROM summary_cache WHERE user_id = ? AND date_str = ?',
                [String(userId), dateStr], (err, row) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(row ? { content: row.content, createdAt: row.created_at, baseCheckpointDate: row.base_checkpoint_date } : null)
                })
        })
    }

    getLatestSummaryCache(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT content, date_str, created_at, base_checkpoint_date FROM summary_cache WHERE user_id = ? ORDER BY date_str DESC LIMIT 1',
                [String(userId)], (err, row) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(row ? { content: row.content, dateStr: row.date_str, createdAt: row.created_at, baseCheckpointDate: row.base_checkpoint_date } : null)
                })
        })
    }

    getAllSummaryCaches(userId) {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT content, date_str, created_at, base_checkpoint_date FROM summary_cache WHERE user_id = ? ORDER BY date_str ASC',
                [String(userId)], (err, rows) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(rows.map(row => ({
                        content: row.content,
                        dateStr: row.date_str,
                        createdAt: row.created_at,
                        baseCheckpointDate: row.base_checkpoint_date
                    })))
                })
        })
    }

    deleteSummaryCache(userId, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM summary_cache WHERE user_id = ? AND date_str = ?',
                [String(userId), dateStr], (err) => {
                    if (err) reject(err)
                    else resolve()
                })
        })
    }

    // ========== 迁移状态方法 ==========

    getCheckpointsMigrationStatus() {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT checkpoints_migrated FROM migration_status WHERE id = 1', (err, row) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(row ? row.checkpoints_migrated : false)
            })
        })
    }

    setCheckpointsMigrationStatus(migrated) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                UPDATE migration_status 
                SET checkpoints_migrated = ?, migration_time = CURRENT_TIMESTAMP 
                WHERE id = 1
            `, [migrated ? 1 : 0], (err) => {
                if (err) reject(err)
                else {
                    // 强制 WAL checkpoint 确保数据持久化到主数据库文件
                    this.db.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
                        if (err) reject(err)
                        else resolve()
                    })
                }
            })
        })
    }

    getSummaryMigrationStatus() {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT summary_migrated FROM migration_status WHERE id = 1', (err, row) => {
                if (err) {
                    reject(err)
                    return
                }
                resolve(row ? row.summary_migrated : false)
            })
        })
    }

    setSummaryMigrationStatus(migrated) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                UPDATE migration_status 
                SET summary_migrated = ?, migration_time = CURRENT_TIMESTAMP 
                WHERE id = 1
            `, [migrated ? 1 : 0], (err) => {
                if (err) reject(err)
                else {
                    // 强制 WAL checkpoint 确保数据持久化
                    this.db.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
                        if (err) reject(err)
                        else resolve()
                    })
                }
            })
        })
    }

    close() {
        this.db.close()
    }
}
