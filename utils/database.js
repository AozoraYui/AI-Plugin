import fs from 'node:fs'
import path from 'node:path'
import sqlite3 from 'sqlite3'

const _path = process.cwd()
const DATA_DIR = path.join(_path, 'data', 'ai_assistant')

export const DB_FILE = path.join(DATA_DIR, 'ai_plugin.db')

export class AIDatabase {
    constructor() {
        this.ensureDataDir()
        this.db = new sqlite3.Database(DB_FILE)
        this.db.run('PRAGMA journal_mode = WAL')
        this.db.run('PRAGMA foreign_keys = ON')
        this.db.run('PRAGMA wal_autocheckpoint = 1000')
        this._initPromise = this.initTables()
    }

    async waitForReady() {
        await this._initPromise
    }

    ensureDataDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true })
        }
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
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
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
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    UNIQUE(user_id, date_str)
                );

                CREATE INDEX IF NOT EXISTS idx_summary_user_date 
                ON summary_cache(user_id, date_str);

                -- 用户档案表
                CREATE TABLE IF NOT EXISTS user_profiles (
                    user_id TEXT PRIMARY KEY,
                    info TEXT NOT NULL,
                    last_updated DATETIME DEFAULT (datetime('now', '+8 hours'))
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

                // 检查表状态并处理
                this.checkAndCreateUserHistoriesTable(resolve, reject)
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
                        created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
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
                    resolve()
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

    clearConversationHistory(userId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM user_histories WHERE user_id = ?', [String(userId)], (err) => {
                if (err) reject(err)
                else resolve()
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

    saveCheckpoint(userId, content, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO memory_checkpoints (user_id, content, date_str)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id, date_str) DO UPDATE SET content = ?, created_at = datetime('now', '+8 hours')
            `, [String(userId), content, dateStr, content], (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    getCheckpoint(userId, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT content, created_at FROM memory_checkpoints WHERE user_id = ? AND date_str = ?',
                [String(userId), dateStr], (err, row) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(row ? { content: row.content, createdAt: row.created_at } : null)
                })
        })
    }

    getLatestCheckpoint(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT content, date_str, created_at FROM memory_checkpoints WHERE user_id = ? ORDER BY date_str DESC LIMIT 1',
                [String(userId)], (err, row) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(row ? { content: row.content, dateStr: row.date_str, createdAt: row.created_at } : null)
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

    saveSummaryCache(userId, content, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT INTO summary_cache (user_id, content, date_str)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id, date_str) DO UPDATE SET content = ?, created_at = datetime('now', '+8 hours')
            `, [String(userId), content, dateStr, content], (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    getSummaryCache(userId, dateStr) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT content, created_at FROM summary_cache WHERE user_id = ? AND date_str = ?',
                [String(userId), dateStr], (err, row) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(row ? { content: row.content, createdAt: row.created_at } : null)
                })
        })
    }

    getLatestSummaryCache(userId) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT content, date_str, created_at FROM summary_cache WHERE user_id = ? ORDER BY date_str DESC LIMIT 1',
                [String(userId)], (err, row) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    resolve(row ? { content: row.content, dateStr: row.date_str, createdAt: row.created_at } : null)
                })
        })
    }

    getAllSummaryCaches(userId) {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT content, date_str, created_at FROM summary_cache WHERE user_id = ? ORDER BY date_str ASC',
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
