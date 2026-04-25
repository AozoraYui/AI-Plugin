import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const _path = process.cwd()
const DATA_DIR = path.join(_path, 'data', 'ai_assistant')

export const DB_FILE = path.join(DATA_DIR, 'ai_plugin.db')

export class AIDatabase {
    constructor() {
        this.ensureDataDir()
        this.db = new Database(DB_FILE)
        this.db.pragma('journal_mode = WAL')
        this.db.pragma('foreign_keys = ON')
        this.initTables()
    }

    ensureDataDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true })
        }
    }

    initTables() {
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
        `)

        const status = this.db.prepare('SELECT json_migrated FROM migration_status WHERE id = 1').get()
        if (!status) {
            this.db.prepare('INSERT INTO migration_status (id, json_migrated) VALUES (1, 0)').run()
        }
    }

    getConversationHistory(userId, limit = null) {
        const userIdStr = String(userId)
        let query = `SELECT role, parts FROM conversations WHERE user_id = ? ORDER BY id ASC`
        if (limit) {
            query += ` LIMIT ?`
            const stmt = this.db.prepare(query)
            return stmt.all(userIdStr, limit).map(row => ({
                role: row.role,
                parts: JSON.parse(row.parts)
            }))
        }
        const stmt = this.db.prepare(query)
        return stmt.all(userIdStr).map(row => ({
            role: row.role,
            parts: JSON.parse(row.parts)
        }))
    }

    saveConversation(userId, history) {
        const userIdStr = String(userId)
        const insert = this.db.prepare(`
            INSERT INTO conversations (user_id, role, parts, date_str)
            VALUES (?, ?, ?, ?)
        `)

        const insertMany = this.db.transaction((entries) => {
            for (const entry of entries) {
                insert.run(entry.user_id, entry.role, entry.parts, entry.date_str)
            }
        })

        const entries = history.map(turn => ({
            user_id: userIdStr,
            role: turn.role,
            parts: JSON.stringify(turn.parts),
            date_str: turn.date_str || new Date().toISOString().split('T')[0]
        }))

        insertMany.run(entries)
    }

    clearConversationHistory(userId) {
        const userIdStr = String(userId)
        this.db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userIdStr)
    }

    getUserProfile(userId) {
        const userIdStr = String(userId)
        const row = this.db.prepare('SELECT info, last_updated FROM user_profiles WHERE user_id = ?').get(userIdStr)
        return row ? { info: row.info, lastUpdated: row.last_updated } : null
    }

    saveUserProfile(userId, info) {
        const userIdStr = String(userId)
        this.db.prepare(`
            INSERT INTO user_profiles (user_id, info, last_updated)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET info = ?, last_updated = CURRENT_TIMESTAMP
        `).run(userIdStr, info, info)
    }

    deleteUserProfile(userId) {
        const userIdStr = String(userId)
        const result = this.db.prepare('DELETE FROM user_profiles WHERE user_id = ?').run(userIdStr)
        return result.changes > 0
    }

    getAllUserIds() {
        return this.db.prepare('SELECT DISTINCT user_id FROM conversations').all().map(row => row.user_id)
    }

    getMigrationStatus() {
        const row = this.db.prepare('SELECT json_migrated, migration_time FROM migration_status WHERE id = 1').get()
        return row || { json_migrated: false, migration_time: null }
    }

    setMigrationStatus(migrated) {
        this.db.prepare(`
            UPDATE migration_status 
            SET json_migrated = ?, migration_time = CURRENT_TIMESTAMP 
            WHERE id = 1
        `).run(migrated ? 1 : 0)
    }

    close() {
        this.db.close()
    }
}
