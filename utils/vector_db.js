import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { Config, DATA_DIR } from './config.js'

const CHROMA_DB_DIR = path.join(DATA_DIR, 'chroma_db')
const PYTHON_SCRIPT = path.join(process.cwd(), 'plugins', 'AI-Plugin', 'scripts', 'vector_server.py')
const REQUIREMENTS_FILE = path.join(process.cwd(), 'plugins', 'AI-Plugin', 'scripts', 'requirements.txt')

class VectorDBClient {
    constructor() {
        this.pythonProcess = null
        this.serverUrl = 'http://127.0.0.1:9901'
        this.isReady = false
        this.pendingRequests = []
    }

    async checkAndInstallPythonDeps() {
        try {
            logger.info('[AI-Plugin] [畅聊] 检查 Python 依赖...')
            
            execSync('python3 --version', { stdio: 'pipe' })
            logger.info('[AI-Plugin] [畅聊] Python3 已安装')

            try {
                execSync('python3 -c "import chromadb; import sentence_transformers"', { stdio: 'pipe' })
                logger.info('[AI-Plugin] [畅聊] Python 依赖已就绪')
                return true
            } catch {
                logger.info('[AI-Plugin] [畅聊] 正在安装 Python 依赖 (chromadb, sentence-transformers)...')
                logger.info('[AI-Plugin] [畅聊] 这可能需要几分钟，请耐心等待...')
                
                execSync('pip3 install -r ' + REQUIREMENTS_FILE, { 
                    stdio: 'inherit',
                    cwd: path.join(process.cwd(), 'plugins', 'AI-Plugin', 'scripts')
                })
                
                logger.info('[AI-Plugin] [畅聊] Python 依赖安装完成')
                return true
            }
        } catch (error) {
            if (error.message.includes('python3')) {
                logger.error('[AI-Plugin] [畅聊] 未找到 Python3，请先安装 Python3')
            } else if (error.message.includes('pip3')) {
                logger.error('[AI-Plugin] [畅聊] 未找到 pip3，请先安装 pip3')
            } else {
                logger.error(`[AI-Plugin] [畅聊] 依赖安装失败: ${error.message}`)
            }
            return false
        }
    }

    async init() {
        const noaConfig = Config.noaChatConfig
        if (!noaConfig.enabled) {
            logger.info('[AI-Plugin] [畅聊] 畅聊模式未启用，跳过向量数据库初始化')
            return
        }

        if (!fs.existsSync(CHROMA_DB_DIR)) {
            fs.mkdirSync(CHROMA_DB_DIR, { recursive: true })
        }

        if (!fs.existsSync(PYTHON_SCRIPT)) {
            logger.warn('[AI-Plugin] [畅聊] Python 向量服务脚本不存在，跳过向量数据库初始化')
            return
        }

        const depsReady = await this.checkAndInstallPythonDeps()
        if (!depsReady) {
            logger.warn('[AI-Plugin] [畅聊] Python 依赖未就绪，跳过向量数据库初始化')
            return
        }

        return new Promise((resolve, reject) => {
            this.pythonProcess = spawn('python3', [PYTHON_SCRIPT, CHROMA_DB_DIR, this.serverUrl], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1' }
            })

            this.pythonProcess.stdout.on('data', (data) => {
                const msg = data.toString().trim()
                logger.info(`[AI-Plugin] [畅聊] [Python] ${msg}`)
                if (msg.includes('Server ready')) {
                    this.isReady = true
                    logger.info('[AI-Plugin] [畅聊] 向量数据库已就绪')
                    this.pendingRequests.forEach(req => req())
                    this.pendingRequests = []
                    resolve()
                }
            })

            this.pythonProcess.stderr.on('data', (data) => {
                logger.error(`[AI-Plugin] [畅聊] [Python Error] ${data.toString().trim()}`)
            })

            this.pythonProcess.on('error', (err) => {
                logger.error(`[AI-Plugin] [畅聊] Python 进程启动失败: ${err.message}`)
                reject(err)
            })

            this.pythonProcess.on('exit', (code) => {
                logger.warn(`[AI-Plugin] [畅聊] Python 进程已退出，代码: ${code}`)
                this.isReady = false
            })

            setTimeout(() => {
                if (!this.isReady) {
                    logger.warn('[AI-Plugin] [畅聊] 向量数据库启动较慢，正在继续等待...')
                }
            }, 60000)

            setTimeout(() => {
                if (!this.isReady) {
                    reject(new Error('向量数据库启动超时（180秒）'))
                }
            }, 180000)
        })
    }

    async waitForReady() {
        if (this.isReady) return
        return new Promise((resolve) => {
            this.pendingRequests.push(resolve)
        })
    }

    async addDocument(id, text, metadata = {}) {
        await this.waitForReady()
        try {
            const response = await fetch(`${this.serverUrl}/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, text, metadata })
            })
            return response.ok
        } catch (error) {
            logger.error(`[AI-Plugin] [畅聊] 添加文档失败: ${error.message}`)
            return false
        }
    }

    async search(query, limit = 10) {
        if (!this.isReady) {
            logger.debug('[AI-Plugin] [畅聊] 向量数据库未就绪，跳过历史检索')
            return []
        }
        try {
            const response = await fetch(`${this.serverUrl}/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, limit })
            })
            if (!response.ok) return []
            const data = await response.json()
            return data.results || []
        } catch (error) {
            logger.error(`[AI-Plugin] [畅聊] 搜索失败: ${error.message}`)
            return []
        }
    }

    async shutdown() {
        if (this.pythonProcess) {
            this.pythonProcess.kill('SIGTERM')
            this.pythonProcess = null
        }
    }
}

export const vectorDB = new VectorDBClient()
