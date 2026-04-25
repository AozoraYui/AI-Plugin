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
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    date_str TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_conversations_user_date 
                ON conversations(user_id, date_str);

                CREATE INDEX IF NOT EXISTS idx_conversations_user_id 
                ON conversations(user_id);

                CREATE TABLE IF NOT EXISTS user_profiles (
                    user_id TEXT PRIMARY KEY,
                    info TEXT NOT NULL,
                    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
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
                        resolve()
                    }
                })
            })
        })
    }

    getConversationHistory(userId) {
        return new Promise((resolve, reject) => {
            const userIdStr = String(userId)
            this.db.all('SELECT role, parts FROM conversations WHERE user_id = ? ORDER BY id ASC', [userIdStr], (err, rows) => {
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

    saveConversation(userId, history) {
        return new Promise((resolve, reject) => {
            const userIdStr = String(userId)
            const insert = this.db.prepare(`
                INSERT INTO conversations (user_id, role, parts, date_str)
                VALUES (?, ?, ?, ?)
            `)

            const entries = history.map(turn => ({
                user_id: userIdStr,
                role: turn.role,
                parts: JSON.stringify(turn.parts),
                date_str: turn.date_str || new Date().toISOString().split('T')[0]
            }))

            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION')
                for (const entry of entries) {
                    insert.run(entry.user_id, entry.role, entry.parts, entry.date_str)
                }
                this.db.run('COMMIT', (err) => {
                    insert.finalize()
                    if (err) reject(err)
                    else resolve()
                })
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
