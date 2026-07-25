import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Config } from './config.js'

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VECTOR_DB_DIR = path.join(PLUGIN_DIR, 'data', 'chroma_db')
const PYTHON_SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'vector_server.py')
const REQUIREMENTS_FILE = path.join(PLUGIN_DIR, 'scripts', 'requirements.txt')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9901
const HEALTH_TIMEOUT_MS = 2500
const STARTUP_TIMEOUT_MS = 180000
const VECTOR_WRITE_TIMEOUT_MS = 300000
const VECTOR_WRITE_RETRY_COUNT = 3
const VECTOR_WRITE_RETRY_BASE_MS = 1500
const VECTOR_WRITE_CHUNK_SIZE = 32
const VECTOR_SERVER_PROTOCOL_VERSION = '2026-07-25.7'

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function readTextFile(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return ''
    }
}

function readDirEntries(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return []
    }
}

function readDirNames(dir) {
    try {
        return fs.readdirSync(dir)
    } catch {
        return []
    }
}

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

function getListeningSocketInodes(port) {
    const portHex = normalizePort(port).toString(16).toUpperCase().padStart(4, '0')
    const inodes = new Set()
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const text = readTextFile(file)
        if (!text) continue
        for (const line of text.split('\n').slice(1)) {
            const parts = line.trim().split(/\s+/)
            const local = parts[1] || ''
            const state = parts[3] || ''
            const inode = parts[9] || ''
            const localPort = local.split(':')[1]
            if (state === '0A' && localPort?.toUpperCase() === portHex && /^\d+$/.test(inode)) {
                inodes.add(inode)
            }
        }
    }
    return inodes
}

function vectorServerArgMatches(arg) {
    const text = String(arg || '')
    if (!text) return false
    if (text === PYTHON_SCRIPT) return true
    if (text.endsWith('/AI-Plugin/scripts/vector_server.py')) return true
    try {
        return path.resolve(text) === PYTHON_SCRIPT
    } catch {
        return false
    }
}

function readProcessArgs(pid) {
    const raw = readTextFile(`/proc/${pid}/cmdline`)
    return raw.split('\0').map(item => item.trim()).filter(Boolean)
}

function findOwnedVectorServerProcesses(port) {
    const inodes = getListeningSocketInodes(port)
    if (inodes.size === 0) return []
    const processes = []
    for (const entry of readDirEntries('/proc')) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
        const pid = entry.name
        const fdDir = `/proc/${pid}/fd`
        let ownsPort = false
        try {
            for (const fd of readDirNames(fdDir)) {
                const link = fs.readlinkSync(path.join(fdDir, fd))
                const match = link.match(/^socket:\[(\d+)]$/)
                if (match && inodes.has(match[1])) {
                    ownsPort = true
                    break
                }
            }
        } catch {
            continue
        }
        if (!ownsPort) continue
        const args = readProcessArgs(pid)
        if (args.some(vectorServerArgMatches) && args.includes(String(port))) {
            processes.push({ pid: Number(pid), args })
        }
    }
    return processes
}

function processExists(pid) {
    return fs.existsSync(`/proc/${pid}`)
}

async function terminatePid(pid) {
    try {
        process.kill(pid, 'SIGTERM')
    } catch (err) {
        return err?.code === 'ESRCH'
    }
    for (let i = 0; i < 20; i++) {
        if (!processExists(pid)) return true
        await sleep(250)
    }
    try {
        process.kill(pid, 'SIGKILL')
    } catch (err) {
        return err?.code === 'ESRCH'
    }
    for (let i = 0; i < 12; i++) {
        if (!processExists(pid)) return true
        await sleep(250)
    }
    return !processExists(pid)
}

async function postJson(url, body, timeoutMs = 30000) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 1000)}` : ''}`)
        }
        return await res.json()
    } catch (err) {
        throw new Error(formatFetchError(err), { cause: err })
    }
}

function formatFetchError(err) {
    const parts = []
    if (err?.name && err.name !== 'Error') parts.push(err.name)
    if (err?.message) parts.push(err.message)
    const cause = err?.cause
    if (cause) {
        const causeParts = []
        if (cause.code) causeParts.push(String(cause.code))
        if (cause.errno) causeParts.push(`errno=${cause.errno}`)
        if (cause.syscall) causeParts.push(`syscall=${cause.syscall}`)
        if (cause.address) causeParts.push(`address=${cause.address}`)
        if (cause.port) causeParts.push(`port=${cause.port}`)
        if (cause.message && cause.message !== err.message) causeParts.push(cause.message)
        if (causeParts.length > 0) parts.push(`cause: ${causeParts.join(', ')}`)
    }
    return [...new Set(parts.filter(Boolean))].join(' | ') || String(err || 'unknown error')
}

function isTransientRequestError(err) {
    const text = formatFetchError(err).toLowerCase()
    return /fetch failed|socket|connect|connection|econn|etimedout|timeout|aborted|terminated|reset|refused|broken pipe|network|und_err|other side closed/.test(text)
}

function chunkArray(items, size) {
    const chunks = []
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
    return chunks
}

export class VectorDBClient {
    constructor() {
        this.pythonProcess = null
        this.isReady = false
        this.initStarted = false
        this.initPromise = null
        this.lastError = ''
        this.writeQueue = Promise.resolve()
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

    get dataDir() {
        return VECTOR_DB_DIR
    }

    get modelName() {
        return String(process.env.AI_PLUGIN_VECTOR_MODEL || Config.VECTOR_MODEL || 'shibing624/text2vec-base-chinese')
    }

    async probeHealth() {
        try {
            const res = await fetch(`${this.serverUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
            })
            if (!res.ok) {
                this.isReady = false
                this.lastError = `${this.serverUrl} 已被占用，/health 返回 HTTP ${res.status}`
                return { reachable: true, compatible: false, ready: false, error: this.lastError }
            }
            const data = await res.json()
            const model = typeof data?.model === 'string' ? data.model.trim() : ''
            const collection = typeof data?.collection === 'string' ? data.collection.trim() : ''
            const serverVersion = typeof data?.server_version === 'string' ? data.server_version.trim() : ''
            if (!model || !collection || data?.ready === undefined) {
                this.isReady = false
                this.lastError = `${this.serverUrl} 已被其他服务占用`
                return { reachable: true, compatible: false, ready: false, error: this.lastError }
            }
            if (serverVersion !== VECTOR_SERVER_PROTOCOL_VERSION) {
                this.isReady = false
                this.lastError = `端口 ${this.port} 已有旧版向量服务: 当前=${serverVersion || '未知'} / 期望=${VECTOR_SERVER_PROTOCOL_VERSION}`
                return { reachable: true, compatible: false, ready: false, error: this.lastError, model, collection, serverVersion }
            }
            if (model !== this.modelName) {
                this.isReady = false
                this.lastError = `端口 ${this.port} 已有向量服务，但模型不匹配: 当前=${model} / 期望=${this.modelName}`
                return { reachable: true, compatible: false, ready: false, error: this.lastError, model, collection }
            }
            const ready = data?.ready === true
            const errorText = typeof data?.error === 'string' ? data.error.trim() : ''
            if (!ready && (data?.failed === true || errorText)) {
                this.isReady = false
                this.lastError = errorText || '向量服务初始化失败'
                return { reachable: true, compatible: true, ready: false, failed: true, error: this.lastError, model, collection }
            }
            this.isReady = ready
            this.lastError = errorText
            return { reachable: true, compatible: true, ready, failed: false, error: this.lastError, model, collection }
        } catch (err) {
            return { reachable: false, compatible: false, ready: false, error: err.message }
        }
    }

    async checkHealth() {
        const health = await this.probeHealth()
        return health.compatible === true && health.ready === true
    }

    async waitForExistingServiceReady(timeoutMs = STARTUP_TIMEOUT_MS) {
        const deadline = Date.now() + timeoutMs
        let lastError = ''
        while (Date.now() < deadline) {
            const health = await this.probeHealth()
            if (!health.reachable) {
                this.lastError = '已存在的向量服务不再响应，请重新执行本命令。'
                return false
            }
            if (!health.compatible) return false
            if (health.failed) return false
            if (health.ready) return true
            lastError = health.error || lastError
            await sleep(1500)
        }
        this.lastError = `已有向量服务在 ${Math.round(timeoutMs / 1000)} 秒内未就绪${lastError ? `: ${lastError}` : ''}`
        return false
    }

    async stopOwnedVectorServer(reason = '') {
        const processes = findOwnedVectorServerProcesses(this.port)
        if (processes.length === 0) {
            this.lastError = `${reason || this.lastError || '向量服务异常'}；未找到可安全停止的 AI-Plugin 向量服务进程，请手动执行 pkill -f 'AI-Plugin/scripts/vector_server.py'`
            return false
        }
        const pids = processes.map(item => item.pid)
        logger.warn(`[AI-Plugin] 检测到异常向量服务，准备停止后重启: pids=${pids.join(',')}${reason ? `, reason=${reason}` : ''}`)
        const results = await Promise.all(processes.map(item => terminatePid(item.pid)))
        const stopped = results.filter(Boolean).length
        const remaining = findOwnedVectorServerProcesses(this.port)
        if (remaining.length > 0) {
            this.lastError = `${reason || this.lastError || '向量服务异常'}；无法停止异常向量服务进程: ${remaining.map(item => item.pid).join(',')}`
            return false
        }
        logger.warn(`[AI-Plugin] 已停止异常向量服务进程: pids=${pids.join(',')}, stopped=${stopped}`)
        return true
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
        this.initPromise = this._init().then(ok => {
            if (!ok) {
                this.initPromise = null
                this.initStarted = false
            }
            return ok
        }).catch(err => {
            this.lastError = err.message
            this.initPromise = null
            this.initStarted = false
            logger.warn(`[AI-Plugin] 向量记忆初始化异常: ${err.message}`)
            return false
        })
        return this.initPromise
    }

    async _init(cleanupTried = false) {
        const health = await this.probeHealth()
        if (health.compatible && health.ready) {
            logger.info(`[AI-Plugin] 向量记忆服务已就绪: ${this.serverUrl}`)
            return true
        }
        if (health.reachable) {
            if (!health.compatible) {
                if (!cleanupTried && health.model && health.collection && await this.stopOwnedVectorServer(this.lastError)) {
                    await sleep(800)
                    return await this._init(true)
                }
                logger.warn(`[AI-Plugin] 向量记忆跳过启动: ${this.lastError}`)
                return false
            }
            if (health.failed) {
                if (!cleanupTried && await this.stopOwnedVectorServer(this.lastError)) {
                    await sleep(800)
                    return await this._init(true)
                }
                logger.warn(`[AI-Plugin] 向量记忆跳过启动: ${this.lastError}`)
                return false
            }
            logger.info(`[AI-Plugin] 检测到已有向量记忆服务正在启动，等待就绪: ${this.serverUrl}`)
            const ready = await this.waitForExistingServiceReady(STARTUP_TIMEOUT_MS)
            if (ready) logger.info(`[AI-Plugin] 向量记忆服务启动完成: ${this.serverUrl}`)
            else logger.warn(`[AI-Plugin] ${this.lastError}`)
            return ready
        }

        if (getListeningSocketInodes(this.port).size > 0) {
            const reason = `端口 ${this.port} 已被无响应服务占用，/health 不可达`
            if (!cleanupTried && await this.stopOwnedVectorServer(reason)) {
                await sleep(800)
                return await this._init(true)
            }
            if (!this.lastError) this.lastError = `${reason}；未启动新的向量服务以避免端口冲突`
            logger.warn(`[AI-Plugin] 向量记忆跳过启动: ${this.lastError}`)
            return false
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
            const failedMatch = msg.match(/Vector database init failed:\s*(.+)$/m)
            if (failedMatch) this.lastError = failedMatch[1].trim()
        })
        this.pythonProcess.stderr.on('data', data => {
            const msg = data.toString().trim()
            if (msg) logger.warn(`[AI-Plugin] [向量服务] ${msg}`)
        })
        this.pythonProcess.on('exit', code => {
            this.isReady = false
            if (code !== 0 && !this.lastError) this.lastError = `向量记忆服务已退出: code=${code}`
            this.initPromise = null
            this.initStarted = false
            logger.warn(`[AI-Plugin] 向量记忆服务已退出: code=${code}`)
        })
        this.pythonProcess.on('error', err => {
            this.lastError = err.message
            this.isReady = false
            this.initPromise = null
            this.initStarted = false
            logger.warn(`[AI-Plugin] 向量记忆服务启动失败: ${err.message}`)
        })

        const deadline = Date.now() + STARTUP_TIMEOUT_MS
        while (Date.now() < deadline) {
            if (await this.checkHealth()) {
                logger.info(`[AI-Plugin] 向量记忆服务启动完成: ${this.serverUrl}`)
                return true
            }
            if (this.pythonProcess?.exitCode !== null && !this.isReady) break
            await sleep(1500)
        }
        if (!this.lastError) this.lastError = '向量记忆服务启动超时'
        logger.warn(`[AI-Plugin] ${this.lastError}`)
        return false
    }

    async waitForReady(timeoutMs = 0) {
        if (this.isReady || await this.checkHealth()) return true
        if (!this.initPromise && this.enabled) this.init().catch(err => {
            this.lastError = err.message
            logger.warn(`[AI-Plugin] 向量记忆初始化异常: ${err.message}`)
        })
        if (!timeoutMs) return false
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (this.isReady || await this.checkHealth()) return true
            await sleep(1000)
        }
        return false
    }

    enqueueWrite(task) {
        const run = this.writeQueue.catch(() => {}).then(task)
        this.writeQueue = run.catch(() => {})
        return run
    }

    async recoverAfterRequestFailure(err) {
        this.isReady = false
        this.lastError = formatFetchError(err)
        const health = await this.probeHealth()
        if (health.compatible && health.ready) return true
        this.initPromise = null
        this.initStarted = false
        const started = await this.init()
        if (!started) return false
        return await this.waitForReady(60000)
    }

    async requestWithRetries(operation, requestFn, retryCount = VECTOR_WRITE_RETRY_COUNT) {
        let lastErr = null
        for (let attempt = 0; attempt <= retryCount; attempt++) {
            try {
                return await requestFn()
            } catch (err) {
                lastErr = err
                const detail = formatFetchError(err)
                this.lastError = detail
                const canRetry = attempt < retryCount && isTransientRequestError(err)
                if (!canRetry) break
                logger.warn(`[AI-Plugin] 向量记忆${operation}失败，准备重试 ${attempt + 1}/${retryCount}: ${detail}`)
                await this.recoverAfterRequestFailure(err)
                await sleep(VECTOR_WRITE_RETRY_BASE_MS * (attempt + 1))
            }
        }
        throw lastErr
    }

    async addDocument(id, text, metadata = {}) {
        return await this.addDocuments([{ id, text, metadata }])
    }

    async addDocuments(documents = []) {
        if (!this.enabled) return false
        const normalized = documents
            .map(doc => ({
                id: String(doc.id || '').trim(),
                text: String(doc.text || '').trim(),
                metadata: sanitizeMetadata(doc.metadata || {})
            }))
            .filter(doc => doc.id && doc.text)
        if (normalized.length === 0) return true
        return await this.enqueueWrite(() => this.addDocumentsNow(normalized))
    }

    async addDocumentsNow(normalized = []) {
        const ready = await this.waitForReady(0)
        if (!ready) return false
        try {
            let written = 0
            for (const chunk of chunkArray(normalized, VECTOR_WRITE_CHUNK_SIZE)) {
                const data = await this.requestWithRetries(`写入 ${chunk.length} 个片段`, async () => {
                    return chunk.length === 1
                        ? await postJson(`${this.serverUrl}/add`, chunk[0], VECTOR_WRITE_TIMEOUT_MS)
                        : await postJson(`${this.serverUrl}/add_many`, { documents: chunk }, VECTOR_WRITE_TIMEOUT_MS)
                })
                if (Number(data?.failed) > 0) {
                    logger.warn(`[AI-Plugin] 向量记忆写入跳过 ${Number(data.failed)} 个异常片段: ${JSON.stringify(data.failures || []).slice(0, 500)}`)
                }
                if (data?.success !== true) {
                    this.lastError = data?.error || `向量记忆写入失败: 成功 ${Number(data?.count) || 0}/${chunk.length} 个片段`
                    return false
                }
                written += Number(data?.count) || chunk.length
            }
            if (written < normalized.length) logger.warn(`[AI-Plugin] 向量记忆写入数量偏少: ${written}/${normalized.length}`)
            return true
        } catch (err) {
            this.lastError = formatFetchError(err)
            logger.warn(`[AI-Plugin] 向量记忆写入失败: ${this.lastError}`)
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
            this.lastError = formatFetchError(err)
            logger.warn(`[AI-Plugin] 向量记忆检索失败: ${this.lastError}`)
            return []
        }
    }

    async stats() {
        if (!this.enabled) return { enabled: false, ready: false, count: 0, dataDir: this.dataDir }
        const ready = await this.waitForReady(0)
        if (!ready) {
            return {
                enabled: true,
                ready: false,
                count: 0,
                model: this.modelName,
                url: this.serverUrl,
                dataDir: this.dataDir,
                error: this.lastError
            }
        }
        try {
            const data = await postJson(`${this.serverUrl}/stats`, {}, 30000)
            const count = Number(data?.count)
            return {
                enabled: true,
                ready: data?.success === true && data?.ready !== false,
                count: Number.isFinite(count) ? count : 0,
                busy: data?.busy === true,
                cached: data?.cached === true,
                model: data?.model || this.modelName,
                collection: data?.collection || '',
                serverVersion: data?.server_version || VECTOR_SERVER_PROTOCOL_VERSION,
                url: this.serverUrl,
                dataDir: this.dataDir
            }
        } catch (err) {
            this.lastError = formatFetchError(err)
            return {
                enabled: true,
                ready: false,
                count: 0,
                model: this.modelName,
                url: this.serverUrl,
                dataDir: this.dataDir,
                error: this.lastError
            }
        }
    }

    async reset() {
        if (!this.enabled) return false
        return await this.enqueueWrite(() => this.resetNow())
    }

    async resetNow() {
        const ready = await this.waitForReady(60000)
        if (!ready) return false
        try {
            const data = await this.requestWithRetries('重置索引', () => postJson(`${this.serverUrl}/reset`, {}, 120000), 2)
            return data?.success === true
        } catch (err) {
            this.lastError = formatFetchError(err)
            logger.warn(`[AI-Plugin] 向量记忆重置失败: ${this.lastError}`)
            return false
        }
    }

    async deleteWhere(where = {}) {
        if (!this.enabled || !where || typeof where !== 'object' || Object.keys(where).length === 0) return false
        return await this.enqueueWrite(() => this.deleteWhereNow(where))
    }

    async deleteWhereNow(where = {}) {
        const ready = await this.waitForReady(0)
        if (!ready) return false
        try {
            const data = await this.requestWithRetries('条件删除', () => postJson(`${this.serverUrl}/delete_where`, { where }, 120000), 2)
            return data?.success === true
        } catch (err) {
            this.lastError = formatFetchError(err)
            logger.warn(`[AI-Plugin] 向量记忆条件删除失败: ${this.lastError}`)
            return false
        }
    }

    shutdown() {
        if (this.pythonProcess) {
            this.pythonProcess.kill('SIGTERM')
            this.pythonProcess = null
        }
        this.isReady = false
        this.initPromise = null
        this.initStarted = false
    }
}

export const vectorDB = new VectorDBClient()

process.once('exit', () => {
    vectorDB.shutdown()
})
