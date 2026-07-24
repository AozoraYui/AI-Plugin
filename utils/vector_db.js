import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Config } from './config.js'

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VECTOR_DB_DIR = path.join(PLUGIN_DIR, 'config', 'chroma_db')
const PYTHON_SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'vector_server.py')
const REQUIREMENTS_FILE = path.join(PLUGIN_DIR, 'scripts', 'requirements.txt')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9901
const HEALTH_TIMEOUT_MS = 2500
const STARTUP_TIMEOUT_MS = 180000

function execFileQuiet(command, args = []) {
    return new Promise(resolve => {
        execFile(command, args, { timeout: 20000 }, (error, stdout = '', stderr = '') => {
            resolve({ ok: !error, error, stdout, stderr })
        })
    })
}

function normalizePort(value) {
    const port = Number(value)
    return Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_PORT
}

function sanitizeMetadata(metadata = {}) {
    const clean = {}
    if (!metadata || typeof metadata !== 'object') return clean
    for (const [key, value] of Object.entries(metadata)) {
        if (value === undefined || value === null) continue
        if (['string', 'number', 'boolean'].includes(typeof value)) clean[key] = value
        else clean[key] = JSON.stringify(value)
    }
    return clean
}

async function postJson(url, body, timeoutMs = 30000) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    return await res.json()
}

export class VectorDBClient {
    constructor() {
        this.pythonProcess = null
        this.isReady = false
        this.initStarted = false
        this.initPromise = null
        this.lastError = ''
    }

    get enabled() {
        return Config.enable_vector_memory === true
    }

    get host() {
        return DEFAULT_HOST
    }

    get port() {
        return normalizePort(Config.VECTOR_SERVER_PORT)
    }

    get pythonBin() {
        return process.env.AI_PLUGIN_VECTOR_PYTHON || 'python3'
    }

    get serverUrl() {
        return `http://${this.host}:${this.port}`
    }

    get modelName() {
        return String(process.env.AI_PLUGIN_VECTOR_MODEL || Config.VECTOR_MODEL || 'shibing624/text2vec-base-chinese')
    }

    async checkHealth() {
        try {
            const res = await fetch(`${this.serverUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
            })
            if (!res.ok) return false
            const data = await res.json()
            this.isReady = data?.ready === true
            this.lastError = data?.error || ''
            return this.isReady
        } catch {
            return false
        }
    }

    async checkPythonDeps() {
        const python = await execFileQuiet(this.pythonBin, ['--version'])
        if (!python.ok) {
            this.lastError = `未找到 Python 解释器: ${this.pythonBin}`
            return false
        }
        const deps = await execFileQuiet(this.pythonBin, ['-c', 'import chromadb; import sentence_transformers'])
        if (!deps.ok) {
            this.lastError = `Python 依赖缺失，请执行: ${this.pythonBin} -m pip install -r ${REQUIREMENTS_FILE}`
            return false
        }
        return true
    }

    async init() {
        if (!this.enabled) {
            logger.info('[AI-Plugin] 向量记忆未启用，跳过初始化')
            return false
        }
        if (this.initPromise) return this.initPromise
        this.initStarted = true
        this.initPromise = this._init()
        return this.initPromise
    }

    async _init() {
        if (await this.checkHealth()) {
            logger.info(`[AI-Plugin] 向量记忆服务已就绪: ${this.serverUrl}`)
            return true
        }

        if (!fs.existsSync(PYTHON_SCRIPT)) {
            this.lastError = `向量服务脚本不存在: ${PYTHON_SCRIPT}`
            logger.warn(`[AI-Plugin] ${this.lastError}`)
            return false
        }
        fs.mkdirSync(VECTOR_DB_DIR, { recursive: true })

        const depsReady = await this.checkPythonDeps()
        if (!depsReady) {
            logger.warn(`[AI-Plugin] 向量记忆跳过启动: ${this.lastError}`)
            return false
        }

        logger.info(`[AI-Plugin] 正在启动本地向量记忆服务: model=${this.modelName}, url=${this.serverUrl}`)
        this.pythonProcess = spawn(this.pythonBin, [PYTHON_SCRIPT, VECTOR_DB_DIR, this.host, String(this.port), this.modelName], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1',
                AI_PLUGIN_VECTOR_MODEL: this.modelName
            }
        })

        this.pythonProcess.stdout.on('data', data => {
            const msg = data.toString().trim()
            if (!msg) return
            logger.info(`[AI-Plugin] [向量服务] ${msg}`)
            if (msg.includes('Vector database ready')) this.isReady = true
        })
        this.pythonProcess.stderr.on('data', data => {
            const msg = data.toString().trim()
            if (msg) logger.warn(`[AI-Plugin] [向量服务] ${msg}`)
        })
        this.pythonProcess.on('exit', code => {
            this.isReady = false
            logger.warn(`[AI-Plugin] 向量记忆服务已退出: code=${code}`)
        })
        this.pythonProcess.on('error', err => {
            this.lastError = err.message
            this.isReady = false
            logger.warn(`[AI-Plugin] 向量记忆服务启动失败: ${err.message}`)
        })

        const deadline = Date.now() + STARTUP_TIMEOUT_MS
        while (Date.now() < deadline) {
            if (await this.checkHealth()) {
                logger.info(`[AI-Plugin] 向量记忆服务启动完成: ${this.serverUrl}`)
                return true
            }
            await new Promise(resolve => setTimeout(resolve, 1500))
        }
        this.lastError = '向量记忆服务启动超时'
        logger.warn(`[AI-Plugin] ${this.lastError}`)
        return false
    }

    async waitForReady(timeoutMs = 0) {
        if (this.isReady || await this.checkHealth()) return true
        if (!this.initStarted && this.enabled) this.init().catch(err => {
            this.lastError = err.message
            logger.warn(`[AI-Plugin] 向量记忆初始化异常: ${err.message}`)
        })
        if (!timeoutMs) return false
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (this.isReady || await this.checkHealth()) return true
            await new Promise(resolve => setTimeout(resolve, 1000))
        }
        return false
    }

    async addDocument(id, text, metadata = {}) {
        return await this.addDocuments([{ id, text, metadata }])
    }

    async addDocuments(documents = []) {
        if (!this.enabled) return false
        const ready = await this.waitForReady(0)
        if (!ready) return false
        const normalized = documents
            .map(doc => ({
                id: String(doc.id || '').trim(),
                text: String(doc.text || '').trim(),
                metadata: sanitizeMetadata(doc.metadata || {})
            }))
            .filter(doc => doc.id && doc.text)
        if (normalized.length === 0) return true
        try {
            const data = normalized.length === 1
                ? await postJson(`${this.serverUrl}/add`, normalized[0])
                : await postJson(`${this.serverUrl}/add_many`, { documents: normalized }, 120000)
            return data?.success === true
        } catch (err) {
            this.lastError = err.message
            logger.warn(`[AI-Plugin] 向量记忆写入失败: ${err.message}`)
            return false
        }
    }

    async search(query, limit = 10, options = {}) {
        if (!this.enabled) return []
        const ready = await this.waitForReady(0)
        if (!ready) return []
        const text = String(query || '').trim()
        if (!text) return []
        try {
            const data = await postJson(`${this.serverUrl}/search`, {
                query: text,
                limit,
                where: options.where || undefined
            }, 60000)
            return Array.isArray(data?.results) ? data.results : []
        } catch (err) {
            this.lastError = err.message
            logger.warn(`[AI-Plugin] 向量记忆检索失败: ${err.message}`)
            return []
        }
    }

    shutdown() {
        if (this.pythonProcess) {
            this.pythonProcess.kill('SIGTERM')
            this.pythonProcess = null
        }
        this.isReady = false
    }
}

export const vectorDB = new VectorDBClient()
