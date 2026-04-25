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
                CREATE TABLE IF NOT EXISTS conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    parts TEXT NOT NULL,
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    date_str TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_conversations_user_date 
                ON conversations(user_id, date_str);

                CREATE INDEX IF NOT EXISTS idx_conversations_user_id 
                ON conversations(user_id);

                CREATE TABLE IF NOT EXISTS user_profiles (
                    user_id TEXT PRIMARY KEY,
                    info TEXT NOT NULL,
                    last_updated DATETIME DEFAULT (datetime('now', '+8 hours'))
                );

                CREATE TABLE IF NOT EXISTS migration_status (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    json_migrated BOOLEAN DEFAULT 0,
                    migration_time DATETIME
                );
            `, (err) => {
                if (err) {
                    reject(err)
                    return
                }

                this.db.get('SELECT json_migrated FROM migration_status WHERE id = 1', (err, row) => {
                    if (err || !row) {
                        this.db.run('INSERT INTO migration_status (id, json_migrated) VALUES (1, 0)', (err) => {
                            if (err) reject(err)
                            else resolve()
                        })
                    } else {
                        // 修复旧数据的 created_at，使其跟随 date_str 的日期（使用中午 12 点作为默认时间）
                        this.db.run("UPDATE conversations SET created_at = date_str || ' 12:00:00' WHERE created_at IS NULL OR strftime('%Y-%m-%d', created_at) != date_str", (err) => {
                            if (err) {
                                // 忽略更新错误
                            }
                            resolve()
                        })
                    }
                })
            })
        })
    }

    getConversationHistory(userId) {
        return new Promise((resolve, reject) => {
            const userIdStr = String(userId)
            this.db.all('SELECT role, parts, date_str FROM conversations WHERE user_id = ? ORDER BY id ASC', [userIdStr], (err, rows) => {
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
            this.db.run('DELETE FROM conversations WHERE user_id = ? AND date_str = ?', [userIdStr, dateStr], (err) => {
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
                    INSERT INTO conversations (user_id, role, parts, date_str)
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
                INSERT INTO conversations (user_id, role, parts, date_str)
                VALUES (?, ?, ?, ?)
            `, [String(userId), role, JSON.stringify(parts), dateStr], (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    clearConversationHistory(userId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM conversations WHERE user_id = ?', [String(userId)], (err) => {
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
            this.db.all('SELECT DISTINCT user_id FROM conversations', [], (err, rows) => {
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
            let query = 'SELECT role, parts, date_str FROM conversations WHERE user_id = ?'
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
            this.db.all('SELECT role, parts FROM conversations WHERE user_id = ? AND date_str = ? ORDER BY id ASC',
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
            let query = 'SELECT DISTINCT user_id FROM conversations WHERE 1=1'
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
            this.db.all('SELECT DISTINCT date_str FROM conversations WHERE user_id = ? ORDER BY date_str ASC',
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
                else resolve()
            })
        })
    }

    close() {
        this.db.close()
    }
}
