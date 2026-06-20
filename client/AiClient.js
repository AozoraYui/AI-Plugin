import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'
import { Config, MODELS_CONFIG_FILE, MODEL_STATUS_FILE, DISABLED_MODELS_FILE, TEMPLATE_DIR_EXPORT } from '../utils/config.js'
import { fetchWithProxy } from '../utils/common.js'
import { toolRegistry } from '../tools/index.js'

// 熔断常量
const CONSECUTIVE_FAILS_THRESHOLD = 3    // 连续失败 N 次后熔断
const COOLDOWN_DURATION_MS = 30000        // 熔断冷却 30 秒
const LATENCY_SAMPLE_WEIGHT = 0.3         // 新延迟占 30% 加权（平滑指数）

export class AiClient {
    constructor() {
        this.modelsConfig = []
        this.modelStatus = {}
        this.disabledModels = new Set()
        this.activeModelPools = {}
        this.commandConfig = {}
        this.visionRelayConfig = { enable_vision_relay: false, vision_model: null }
        this.webSearchConfig = { enabled: false, intent_model: null }
        this.webFetchConfig = { enabled: false }
        this.fileReadConfig = { enabled: false }
        this.shellExecConfig = { enabled: false }
        this.weatherApiKey = null
        this.openWeatherMapApiKey = null
        this.loadModelsConfig()
        toolRegistry.setWeatherApiKey(this.weatherApiKey)
        toolRegistry.setOpenWeatherMapApiKey(this.openWeatherMapApiKey)
        this.loadModelStatus()
        this.loadDisabledModels()
        this._buildActiveModelPools()
    }

    /** 是否启用图文转述 */
    get enableVisionRelay() {
        return this.visionRelayConfig?.enable_vision_relay === true &&
               !!(this.hasVisionModels)
    }

    /** 是否有可用的 Vision 模型 */
    get hasVisionModels() {
        const v = this.visionRelayConfig?.vision_model
        if (!v) return false
        // 兼容旧格式（单对象）
        if (v.provider_id && v.model_id) return true
        // 新格式（列表）
        if (Array.isArray(v) && v.length > 0) return v.some(m => m.provider_id && m.model_id)
        return false
    }

    /** Vision 模型配置列表（统一返回数组） */
    get visionModels() {
        const v = this.visionRelayConfig?.vision_model
        if (!v) return []
        // 兼容旧格式（单对象）
        if (v.provider_id && v.model_id) return [{ provider_id: v.provider_id, model_id: v.model_id }]
        // 新格式（列表）
        if (Array.isArray(v)) return v.filter(m => m.provider_id && m.model_id)
        return []
    }

    /** 检查 payload 是否包含图片 */
    _payloadHasImages(payload) {
        const contents = payload?.contents
        if (!Array.isArray(contents) || contents.length === 0) return false
        // 只检查当前用户回合（最后一条 user 消息），避免历史记录里的旧图片导致误判
        let lastUserContent = null
        for (let i = contents.length - 1; i >= 0; i--) {
            if (contents[i]?.role === 'user') {
                lastUserContent = contents[i]
                break
            }
        }
        if (!lastUserContent) lastUserContent = contents[contents.length - 1]
        return lastUserContent?.parts?.some(part => part.inline_data?.data) === true
    }

    /** 检查当前模型组是否有可用多模态对话模型 */
    _modelGroupHasMultimodalChatModel(modelGroupKey, providerFilter = null) {
        let pool = this.activeModelPools[modelGroupKey]?.chat || []
        if (providerFilter !== null) {
            pool = pool.filter(item => item.provider.priority === providerFilter)
        }
        return pool.some(item => item.provider.multimodal)
    }

    /** 检查当前模型组是否所有对话模型都来自非多模态 provider（需要 Vision Relay） */
    _checkModelGroupNeedsVisionRelay(modelGroupKey, providerFilter = null) {
        const pool = this.activeModelPools[modelGroupKey]?.chat
        if (!pool || pool.length === 0) return true  // 无模型，保守启用
        const scopedPool = providerFilter !== null
            ? pool.filter(item => item.provider.priority === providerFilter)
            : pool
        if (scopedPool.length === 0) return true
        return scopedPool.every(item => !item.provider.multimodal)
    }

    /**
     * 快捷意图分析请求：直接用配置的意图分析模型尝试，绕过模型池排序
     * 用于联网搜索意图分析等轻量任务，大幅减少延迟
     * @param {object} payload - 请求体
     * @returns {object|null} 成功返回 { success, data, platform }，失败返回 null
     */
    async quickIntentRequest(payload) {
        const intentModels = this.webSearchIntentModels
        if (intentModels.length === 0) return null

        for (const modelConfig of intentModels) {
            const provider = this.modelsConfig.find(p => p.id === modelConfig.provider_id)
            if (!provider) {
                logger.warn(`[AI-Plugin] 意图分析模型供应商不存在: ${modelConfig.provider_id}`)
                continue
            }
            const startTime = Date.now()
            const result = await this.attemptRequest('chat', payload, provider, modelConfig.model_id, 1024, 30000)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
            if (result.success) {
                logger.info(`[AI-Plugin] 意图分析成功: ${provider.name}/${modelConfig.model_id}, 耗时 ${elapsed}s`)
                return result
            }
            logger.warn(`[AI-Plugin] 意图分析失败: ${provider.name}/${modelConfig.model_id}, 耗时 ${elapsed}s, 错误: ${result.error}`)
        }
        return null
    }

    /** 对话指令关键词 */
    get chatCommand() {
        return this.commandConfig?.CHAT_COMMAND || 'chat'
    }

    /** 绘图指令关键词 */
    get drawCommand() {
        return this.commandConfig?.DRAW_COMMAND || 'draw'
    }

    /** 是否启用联网搜索 */
    get enableWebSearch() {
        return (this.webSearchConfig?.enable_web_search ?? this.webSearchConfig?.enabled) !== false
    }

    /** 是否启用网页抓取 */
    get enableWebFetch() {
        return (this.webFetchConfig?.enable_web_fetch ?? this.webFetchConfig?.enabled) === true
    }

    /** 是否启用本地文件读取（默认关闭，需配置明确启用） */
    get enableFileRead() {
        return (this.fileReadConfig?.enable_file_read ?? this.fileReadConfig?.enabled) === true
    }

    /** 是否允许 AI 执行 Shell（仅需 Shell 开关；开启即默认具备文件读取能力） */
    get enableShellExec() {
        return this.shellExecConfig?.enabled === true
    }

    /** 是否启用文件收发（上传服务器文件到会话 / 下载会话媒体到服务器，仅主人） */
    get enableFileTransfer() {
        return this.fileTransferConfig?.enabled === true
    }

    /** 是否启用 AI 对话联动画图（在对话中按意图调用插件画图能力） */
    get enableAiDraw() {
        return this.aiDrawConfig?.enabled === true
    }

    /** 是否启用群管理（禁言/踢人/入群审核等，主人或群管理员可在对话中触发） */
    get enableGroupAdmin() {
        return this.groupAdminConfig?.enabled === true
    }

    /** 搜索意图分析专用模型列表 */
    get webSearchIntentModels() {
        const models = this.webSearchConfig?.intent_model
        if (!models || !Array.isArray(models)) return []
        return models.filter(m => m.provider_id && m.model_id)
    }

    /** 初始化模型状态条目（兼容旧格式） */
    _initModelStatusEntry(key) {
        const entry = this.modelStatus[key]
        if (!entry) {
            this.modelStatus[key] = {
                success_count: 0,
                fail_count: 0,
                avg_latency_ms: 0,
                last_used: 0,
                consecutive_fails: 0,
                cooldown_until: 0
            }
            return
        }
        // 兼容旧格式：补充缺失字段
        if (entry.success_count === undefined) entry.success_count = 0
        if (entry.fail_count === undefined) entry.fail_count = 0
        if (entry.avg_latency_ms === undefined) entry.avg_latency_ms = 0
        if (entry.last_used === undefined) entry.last_used = 0
        if (entry.consecutive_fails === undefined) entry.consecutive_fails = 0
        if (entry.cooldown_until === undefined) entry.cooldown_until = 0
    }

    /** 记录模型请求成功 */
    _recordModelSuccess(key, elapsedMs) {
        const entry = this.modelStatus[key]
        if (!entry) return
        entry.success_count = (entry.success_count || 0) + 1
        entry.consecutive_fails = 0
        entry.cooldown_until = 0
        entry.last_used = Date.now()
        // 平滑加权计算平均延迟
        if (entry.avg_latency_ms) {
            entry.avg_latency_ms = Math.round(
                entry.avg_latency_ms * (1 - LATENCY_SAMPLE_WEIGHT) + elapsedMs * LATENCY_SAMPLE_WEIGHT
            )
        } else {
            entry.avg_latency_ms = elapsedMs
        }
    }

    /** 记录模型请求失败，超过阈值触发熔断 */
    _recordModelFail(key) {
        const entry = this.modelStatus[key]
        if (!entry) return
        entry.fail_count = (entry.fail_count || 0) + 1
        entry.consecutive_fails = (entry.consecutive_fails || 0) + 1
        entry.last_used = Date.now()
        if (entry.consecutive_fails >= CONSECUTIVE_FAILS_THRESHOLD) {
            entry.cooldown_until = Date.now() + COOLDOWN_DURATION_MS
            logger.warn(`[AI-Plugin] 模型 ${key} 连续失败 ${entry.consecutive_fails} 次，进入 ${COOLDOWN_DURATION_MS / 1000}s 熔断`)
        }
    }

    /** 检查模型是否在熔断期 */
    _isInCooldown(entry) {
        if (!entry?.cooldown_until) return false
        return Date.now() < entry.cooldown_until
    }

    /** 计算模型得分（越高越好） */
    _getModelScore(entry) {
        // 在熔断期直接返回 -1（排除）
        if (this._isInCooldown(entry)) return -1

        const total = (entry.success_count || 0) + (entry.fail_count || 0)
        if (total === 0) return 0 // 新模型，放中间

        const successRate = (entry.success_count || 0) / total
        // 成功率权重 70%，延迟权重 30%
        const latencyScore = entry.avg_latency_ms
            ? Math.max(0, 1 - entry.avg_latency_ms / 30000)
            : 0.5
        return successRate * 0.7 + latencyScore * 0.3
    }

    /** 智能排序模型池：先按 provider priority 分组，再按成本档（按量优先），同档内按得分排序 */
    _sortModelPool(pool) {
        const scored = pool.map(item => {
            const key = `${item.provider.id}-${item.modelId}`
            if (!this.modelStatus[key]) this._initModelStatusEntry(key)
            const priority = item.provider.priority ?? 1
            const score = this._getModelScore(this.modelStatus[key])
            // 成本档：0=按量计费（优先），1=按次扣费（尽量避开）
            const costTier = item.perCall ? 1 : 0
            return { ...item, score, priority, costTier }
        })

        // 排序优先级：priority 升 → 可用性（熔断排末尾）→ 成本档（按量优先）→ 得分降
        scored.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority
            // 熔断模型（score < 0）统一沉底，不参与成本/得分比较
            const aDown = a.score < 0
            const bDown = b.score < 0
            if (aDown !== bDown) return aDown ? 1 : -1
            if (!aDown && a.costTier !== b.costTier) return a.costTier - b.costTier
            return b.score - a.score
        })

        const logging = scored.map(s =>
            `${s.provider.name}(${s.modelId}) [P${s.priority}]${s.costTier ? '[按次]' : ''} 得分:${s.score.toFixed(2)}`
        ).join(', ')
        logger.debug(`[AI-Plugin] 模型排序: ${logging}`)

        return scored
    }

    loadModelsConfig() {
        this.modelsConfig = []
        this.commandConfig = {}
        this.visionRelayConfig = { enable_vision_relay: false, vision_model: null }
        this.webSearchConfig = { enabled: false, intent_model: null }
        this.webFetchConfig = { enabled: false }
        this.fileReadConfig = { enabled: false }
        this.weatherApiKey = null
        this.openWeatherMapApiKey = null
        if (!fs.existsSync(MODELS_CONFIG_FILE)) {
            logger.info(`[AI-Plugin] 未找到模型配置文件，将从模板创建。`)
            const templatePath = path.join(TEMPLATE_DIR_EXPORT, 'models_config.yaml')
            if (fs.existsSync(templatePath)) {
                fs.copyFileSync(templatePath, MODELS_CONFIG_FILE)
            } else {
                logger.warn(`[AI-Plugin] 模板文件不存在: ${templatePath}`)
            }
        }

        try {
            const fileContent = fs.readFileSync(MODELS_CONFIG_FILE, 'utf8')
            // 支持多文档 YAML：doc0=供应商列表, doc1=指令自定义, doc2=Vision Relay
            const allDocs = yaml.parseAllDocuments(fileContent)
            const providersDoc = allDocs[0]
            const commandDoc = allDocs[1]
            const visionDoc = allDocs[2] || allDocs[1]  // 兼容旧格式（只有2个文档时，doc1=vision）
            const webSearchDoc = allDocs[3]               // web_search 配置（第4个文档）

            if (providersDoc) {
                const configs = providersDoc.toJS()
                if (Array.isArray(configs)) {
                    for (const provider of configs) {
                        if (!provider.model_groups || typeof provider.model_groups !== 'object') {
                            logger.error(`[AI-Plugin] 供应商 ${provider.id} 的配置缺少 'model_groups'，已跳过。`)
                            continue
                        }
                        this.modelsConfig.push(provider)
                    }
                    logger.debug(`[AI-Plugin] 成功加载 ${this.modelsConfig.length} 个供应商配置。`)
                } else {
                    throw new Error("模型配置文件格式不正确，第一个文档应为YAML数组。")
                }
            } else {
                throw new Error("模型配置文件为空或格式不正确。")
            }

            if (visionDoc) {
                const visionConfig = visionDoc.toJS()
                const cmdConfig = commandDoc?.toJS() || {}

                // 检测旧格式：如果 doc1 没有 CHAT_COMMAND/DRAW_COMMAND 但有 enable_vision_relay，则是旧格式
                const isLegacyFormat = allDocs.length === 2 &&
                    !(cmdConfig?.hasOwnProperty?.('CHAT_COMMAND') || cmdConfig?.hasOwnProperty?.('DRAW_COMMAND'))

                if (isLegacyFormat) {
                    // 旧格式：doc1 就是 vision relay
                    if (cmdConfig && typeof cmdConfig === 'object' && cmdConfig.hasOwnProperty?.('enable_vision_relay')) {
                        this.visionRelayConfig = cmdConfig
                    }
                } else {
                    // 新格式：doc1=指令, doc2=vision
                    if (visionConfig && typeof visionConfig === 'object' && visionConfig.hasOwnProperty?.('enable_vision_relay')) {
                        this.visionRelayConfig = visionConfig
                    }
                }

                // 解析指令配置
                if (cmdConfig && typeof cmdConfig === 'object' && (cmdConfig.CHAT_COMMAND || cmdConfig.DRAW_COMMAND)) {
                    this.commandConfig = cmdConfig
                    if (this.chatCommand !== 'chat' || this.drawCommand !== 'draw') {
                        logger.info(`[AI-Plugin] 指令已自定义: chat=${this.chatCommand}, draw=${this.drawCommand}`)
                    }
                }

                if (this.enableVisionRelay) {
                    const models = this.visionModels
                    const names = models.map(m => `${m.provider_id}/${m.model_id}`).join(', ')
                    logger.info(`[AI-Plugin] Vision Relay 已启用: ${models.length} 个模型 (${names})`)
                } else {
                    logger.debug('[AI-Plugin] Vision Relay 未启用或配置不完整')
                }
            }

            // 解析 web_search 配置
            if (webSearchDoc) {
                let rawConfig = webSearchDoc.toJS()
                // 兼容两种格式：带 web_search 包裹或不带
                rawConfig = rawConfig.web_search || rawConfig
                // 兼容缩进嵌套：如果 intent_model 被误缩进到 enable_web_search 下，
                // YAML 会把 "true" 和 "intent_model" 合并成一个 key，如 "true intent_model"
                if (rawConfig.enable_web_search && typeof rawConfig.enable_web_search === 'object') {
                    const nested = rawConfig.enable_web_search
                    const intentKey = Object.keys(nested).find(k => k.includes('intent_model'))
                    // 从合并的 key 中提取原始 boolean 值（如 "false intent_model" → false）
                    const wasFalse = Object.keys(nested).some(k => /^(false|no|off|0)$/i.test(k))
                    const enableValue = !wasFalse
                    if (intentKey) {
                        rawConfig = { intent_model: nested[intentKey], enable_web_search: enableValue }
                    } else {
                        rawConfig = { ...nested, enable_web_search: enableValue }
                    }
                }
                this.webSearchConfig = rawConfig
                if (this.enableWebSearch) {
                    const intentModels = this.webSearchIntentModels
                    if (intentModels.length > 0) {
                        const names = intentModels.map(m => `${m.provider_id}/${m.model_id}`).join(', ')
                        logger.info(`[AI-Plugin] 联网搜索已启用: ${intentModels.length} 个意图分析模型 (${names})`)
                    } else {
                        logger.info('[AI-Plugin] 联网搜索已启用（使用 Flash 模型组做意图分析）')
                    }
                } else {
                    logger.info('[AI-Plugin] 联网搜索已禁用')
                }

                // 提取 enable_web_fetch（与 web_search 同文档）
                this.webFetchConfig = { enabled: rawConfig.enable_web_fetch === true }
                if (this.enableWebFetch) {
                    logger.info('[AI-Plugin] 网页抓取已启用')
                } else {
                    logger.debug('[AI-Plugin] 网页抓取未启用')
                }

                // 提取 enable_file_read（默认关闭）
                this.fileReadConfig = { enabled: rawConfig.enable_file_read === true }
                this.shellExecConfig = { enabled: rawConfig.enable_shell_exec === true }
                this.fileTransferConfig = { enabled: rawConfig.enable_file_transfer === true }
                this.aiDrawConfig = { enabled: rawConfig.enable_ai_draw === true }
                this.groupAdminConfig = { enabled: rawConfig.enable_group_admin === true }
                for (const key of ['SHELL_EXEC_TIMEOUT_MS', 'SHELL_EXEC_MAX_TIMEOUT_MS', 'SHELL_EXEC_MAX_OUTPUT_CHARS', 'SHELL_EXEC_FOLLOWUP_MAX_ROUNDS', 'SHELL_EXEC_FOLLOWUP_CONTEXT_CHARS', 'SHELL_EXEC_MAX_BUFFER']) {
                    if (rawConfig[key] !== undefined) Config[key] = rawConfig[key]
                }
                if (this.enableFileRead) {
                    logger.info('[AI-Plugin] 本地文件读取已启用')
                } else {
                    logger.debug('[AI-Plugin] 本地文件读取未启用（可通过 #cf/#scf 临时调用）')
                }
                if (this.enableShellExec) {
                    logger.warn('[AI-Plugin] Shell 执行工具已启用：AI 可在主人请求下执行服务器命令（含文件读取）')
                }
                if (this.enableFileTransfer) {
                    logger.info('[AI-Plugin] 文件收发已启用：主人可让 AI 上传白名单文件到会话、下载会话媒体到白名单目录')
                }
                if (this.enableAiDraw) {
                    logger.info('[AI-Plugin] AI 对话画图已启用：可在对话中按意图调用插件画图能力')
                }
                if (this.enableGroupAdmin) {
                    logger.info('[AI-Plugin] 群管理已启用：主人或群管理员可让 AI 执行禁言/踢人/入群审核等操作')
                }

                // 提取 weather_api_key（高德地图天气查询）
                this.weatherApiKey = rawConfig.weather_api_key || null
                if (this.weatherApiKey) {
                    logger.info('[AI-Plugin] 天气查询已配置高德 API Key')
                }

                // 提取 openweathermap_api_key
                this.openWeatherMapApiKey = rawConfig.openweathermap_api_key || null
                if (this.openWeatherMapApiKey) {
                    logger.info('[AI-Plugin] 天气查询已配置 OpenWeatherMap API Key')
                }
            }
        } catch (error) {
            logger.error(`[AI-Plugin] 加载模型配置文件失败: ${error.message}`)
        }
    }

    loadModelStatus() {
        if (fs.existsSync(MODEL_STATUS_FILE)) {
            try {
                const data = fs.readFileSync(MODEL_STATUS_FILE, 'utf8')
                this.modelStatus = JSON.parse(data)
                // 迁移：删除旧格式中的 status 字段
                let migrated = false
                for (const key of Object.keys(this.modelStatus)) {
                    if (key.startsWith('_')) continue
                    if (this.modelStatus[key]?.status !== undefined) {
                        delete this.modelStatus[key].status
                        migrated = true
                    }
                }
                if (migrated) {
                    logger.info('[AI-Plugin] 已迁移旧格式模型状态，删除 status 字段')
                    this.saveModelStatus()
                }
            } catch (error) {
                logger.error('[AI-Plugin] 加载模型状态文件失败:', error)
                this.modelStatus = {}
            }
        } else {
            logger.info(`[AI-Plugin] 未找到模型状态文件，将从模板创建。`)
            this.modelStatus = {}
            const templatePath = path.join(TEMPLATE_DIR_EXPORT, 'model_status.json')
            if (fs.existsSync(templatePath)) {
                fs.copyFileSync(templatePath, MODEL_STATUS_FILE)
            } else {
                fs.writeFileSync(MODEL_STATUS_FILE, '{}\n', 'utf8')
            }
        }
    }

    saveModelStatus() {
        try {
            const tmpFile = MODEL_STATUS_FILE + '.tmp'
            fs.writeFileSync(tmpFile, JSON.stringify(this.modelStatus, null, 2), 'utf8')
            fs.renameSync(tmpFile, MODEL_STATUS_FILE)
        } catch (error) {
            logger.error('[AI-Plugin] 保存模型状态文件失败:', error)
        }
    }

    loadDisabledModels() {
        try {
            if (fs.existsSync(DISABLED_MODELS_FILE)) {
                const data = fs.readFileSync(DISABLED_MODELS_FILE, 'utf8')
                this.disabledModels = new Set(JSON.parse(data))
                logger.debug(`[AI-Plugin] 成功加载 ${this.disabledModels.size} 个禁用的模型。`)
            } else {
                logger.info(`[AI-Plugin] 未找到禁用模型列表文件，将从模板创建。`)
                this.disabledModels = new Set()
                const templatePath = path.join(TEMPLATE_DIR_EXPORT, 'disabled_models.json')
                if (fs.existsSync(templatePath)) {
                    fs.copyFileSync(templatePath, DISABLED_MODELS_FILE)
                } else {
                    fs.writeFileSync(DISABLED_MODELS_FILE, '[]\n', 'utf8')
                }
            }
        } catch (error) {
            logger.error('[AI-Plugin] 加载禁用模型列表文件失败:', error)
            this.disabledModels = new Set()
        }
    }

    saveDisabledModels() {
        try {
            const tmpFile = DISABLED_MODELS_FILE + '.tmp'
            const data = JSON.stringify(Array.from(this.disabledModels), null, 2)
            fs.writeFileSync(tmpFile, data, 'utf8')
            fs.renameSync(tmpFile, DISABLED_MODELS_FILE)
        } catch (error) {
            logger.error('[AI-Plugin] 保存禁用模型列表文件失败:', error)
        }
    }

    /** 判断某模型是否为按次扣费（命中供应商的 per_call_models 名单） */
    _isPerCallModel(provider, modelId) {
        const list = provider?.per_call_models
        if (!Array.isArray(list) || list.length === 0) return false
        return list.includes(modelId)
    }

    _buildActiveModelPools() {
        this.activeModelPools = {}

        for (const provider of this.modelsConfig) {
            for (const groupName in provider.model_groups) {
                if (!this.activeModelPools[groupName]) {
                    this.activeModelPools[groupName] = { chat: [], image: [] }
                }
            }
        }

        for (const provider of this.modelsConfig) {
            for (const groupName in provider.model_groups) {
                const group = provider.model_groups[groupName]

                if (group.chat_models) {
                    for (const modelId of group.chat_models) {
                        const statusKey = `${provider.id}-${modelId}`
                        // 跳过手动禁用的模型
                        if (this.disabledModels.has(statusKey)) continue
                        this._initModelStatusEntry(statusKey)
                        const perCall = this._isPerCallModel(provider, modelId)
                        this.activeModelPools[groupName].chat.push({ provider, modelId, perCall })
                    }
                }
                if (group.draw_models) {
                    for (const modelId of group.draw_models) {
                        const statusKey = `${provider.id}-${modelId}`
                        // 跳过手动禁用的模型
                        if (this.disabledModels.has(statusKey)) continue
                        this._initModelStatusEntry(statusKey)
                        const perCall = this._isPerCallModel(provider, modelId)
                        this.activeModelPools[groupName].image.push({ provider, modelId, perCall })
                    }
                }
            }
        }

        let logMsg = '[AI-Plugin] 可用模型池已更新：'
        for (const groupName in this.activeModelPools) {
            const chatCount = this.activeModelPools[groupName].chat.length
            const drawCount = this.activeModelPools[groupName].image.length
            logMsg += `\n  - 分组 [${groupName}]: 对话 ${chatCount} 个, 绘图 ${drawCount} 个`
        }
        logger.debug(logMsg)
        // 持久化可能的旧格式升级
        this.saveModelStatus()
    }

    buildRequest(type, payload, providerConfig, modelId, maxTokens = 8192) {
        if (type === 'image' && this._isOpenAIImageModel(modelId)) {
            return this._buildDirectImageRequest(payload, providerConfig, modelId)
        }

        const url = `${providerConfig.base_url}/chat/completions`
        const options = {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${providerConfig.api_key}`,
                "HTTP-Referer": "https://yuzubot.com",
                "X-Title": "Yuzu-Bot"
            },
            body: JSON.stringify({
                model: modelId,
                messages: this.convertToOpenAIMessages(payload),
                max_tokens: maxTokens,
                stream: false,
            })
        }
        return { url, options }
    }

    /** gpt-image 系列直接使用 OpenAI images API，避免先请求 chat/completions 再重试 */
    _isOpenAIImageModel(modelId) {
        return /^gpt-image(?:-|$)/i.test(modelId || '')
    }

    _buildDirectImageRequest(payload, providerConfig, modelId) {
        const parts = payload.contents?.[0]?.parts || []
        const prompt = parts.map(p => p.text).filter(Boolean).join('\n') || ''
        const images = this._extractImageBuffers(parts)
        const commonHeaders = {
            'Authorization': `Bearer ${providerConfig.api_key}`,
            'HTTP-Referer': 'https://yuzubot.com',
            'X-Title': 'Yuzu-Bot'
        }

        if (images.length > 0) {
            const url = `${providerConfig.base_url}/images/edits`
            const fields = [
                { name: 'model', value: modelId },
                { name: 'prompt', value: prompt },
                { name: 'n', value: '1' }
            ]
            const files = images.map((img, i) => ({
                name: 'image',
                buffer: img.buffer,
                filename: `reference_${i + 1}.${img.mimeType.split('/')[1] || 'png'}`,
                contentType: img.mimeType
            }))
            const { headers, body } = this._buildMultipartForm(fields, files)
            logger.info(`[AI-Plugin] 模型 [${providerConfig.name} - ${modelId}] 直接使用 /images/edits（${images.length} 张参考图）`)
            return { url, options: { method: 'POST', headers: { ...headers, ...commonHeaders }, body } }
        }

        const url = `${providerConfig.base_url}/images/generations`
        logger.info(`[AI-Plugin] 模型 [${providerConfig.name} - ${modelId}] 直接使用 /images/generations`)
        return {
            url,
            options: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...commonHeaders },
                body: JSON.stringify({ model: modelId, prompt, n: 1 })
            }
        }
    }

    convertToOpenAIMessages(requestPayload) {
        const messages = []
        for (const content of requestPayload.contents) {
            const role = content.role === 'model' ? 'assistant' : 'user'
            const messageContent = []

            for (const part of content.parts) {
                if (part.text) {
                    messageContent.push({ type: 'text', text: part.text })
                }
                if (part.inline_data) {
                    const mimeType = part.inline_data.mime_type
                    const base64Data = part.inline_data.data
                    messageContent.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${mimeType};base64,${base64Data}`
                        }
                    })
                }
            }
            messages.push({ role, content: messageContent })
        }
        return messages
    }

    _normalizeUsage(usage) {
        if (!usage) return null
        const normalized = { ...usage }
        if (normalized.prompt_tokens === undefined && normalized.input_tokens !== undefined) {
            normalized.prompt_tokens = normalized.input_tokens
        }
        if (normalized.completion_tokens === undefined && normalized.output_tokens !== undefined) {
            normalized.completion_tokens = normalized.output_tokens
        }
        if (normalized.completion_tokens === undefined && normalized.image_tokens !== undefined) {
            normalized.completion_tokens = normalized.image_tokens
        }
        if (normalized.completion_tokens === undefined && normalized.total_tokens !== undefined && normalized.prompt_tokens !== undefined) {
            normalized.completion_tokens = normalized.total_tokens - normalized.prompt_tokens
        }
        if (normalized.prompt_tokens === undefined && normalized.total_tokens !== undefined && normalized.completion_tokens !== undefined) {
            normalized.prompt_tokens = normalized.total_tokens - normalized.completion_tokens
        }
        if (normalized.total_tokens === undefined && normalized.prompt_tokens !== undefined && normalized.completion_tokens !== undefined) {
            normalized.total_tokens = normalized.prompt_tokens + normalized.completion_tokens
        }
        return normalized
    }

    parseResponse(data, type) {
        if (data.error) {
            const errorMsg = data.error.message || data.error || '未知错误'
            return { success: false, error: typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg) }
        }

        const usage = this._normalizeUsage(data.usage)

        if (type === 'chat') {
            const text = data.choices?.[0]?.message?.content
            if (text) {
                return { success: true, data: text, usage: usage }
            }
            return { success: false, error: 'AI返回了空消息。这可能是由于内容安全策略或模型内部错误。' }
        }

        if (type === 'image') {
            let generatedImageUrl = null

            // OpenAI images API 标准格式: data.data[0].url
            generatedImageUrl = data?.data?.[0]?.url

            // 兼容格式: data.choices[0].message.images[0].image_url.url
            if (!generatedImageUrl) {
                generatedImageUrl = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
                    data?.choices?.[0]?.message?.images?.[0]?.url
            }

            // 兼容格式: data.choices[0].message.content 中的 markdown 图片链接
            if (!generatedImageUrl) {
                const responseText = data?.choices?.[0]?.message?.content || ""
                const imageUrlMatch = responseText.match(/!\[.*?\]\((.*?)\)/)
                if (imageUrlMatch && imageUrlMatch[1]) {
                    generatedImageUrl = imageUrlMatch[1]
                }
            }

            // 如果是 base64 格式 (data.data[0].b64_json)，转换为 data URL
            if (!generatedImageUrl && data?.data?.[0]?.b64_json) {
                generatedImageUrl = `data:image/png;base64,${data.data[0].b64_json}`
            }

            if (generatedImageUrl) {
                return { success: true, data: generatedImageUrl, usage: usage }
            }

            const textContent = data.choices?.[0]?.message?.content
            if (textContent) {
                return { success: true, data: textContent, usage: usage }
            }

            return { success: false, error: 'AI返回了空响应，既未生成图片也未提供文本说明。' }
        }
    }

    parseStreamResponse(streamText, type) {
        const lines = streamText.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))

        let accumulatedContent = ""
        let imageUrlInStream = null

        for (const line of lines) {
            try {
                const jsonStr = line.substring(6).trim()
                if (!jsonStr) continue
                const chunk = JSON.parse(jsonStr)

                const deltaContent = chunk.choices?.[0]?.delta?.content
                if (deltaContent) {
                    accumulatedContent += deltaContent
                }
            } catch (e) {
                // 忽略无法解析的行
            }
        }

        const imageMatch = accumulatedContent.match(/!\[.*?\]\((data:image\/[^)]+)\)/)
        if (imageMatch && imageMatch[1]) {
            imageUrlInStream = imageMatch[1]
        }

        let messageObject = { content: accumulatedContent }
        if (type === 'image' && imageUrlInStream) {
            messageObject.images = [{ image_url: { url: imageUrlInStream } }]
        }

        return {
            choices: [{
                message: messageObject
            }]
        }
    }

    async attemptRequest(type, payload, provider, modelId, maxTokens = 8192, timeout = 0) {
        try {
            const { url, options } = this.buildRequest(type, payload, provider, modelId, maxTokens)
            if (timeout > 0) options.timeout = timeout
            
            // 检查请求体大小，防止 413 错误
            const bodySize = Buffer.byteLength(options.body, 'utf8')
            if (bodySize > 10 * 1024 * 1024) { // 10MB 警告阈值
                logger.warn(`[AI-Plugin] 请求体过大 (${(bodySize / 1024 / 1024).toFixed(2)}MB)，可能导致 413 错误`)
            }
            
            const res = await fetchWithProxy(url, options)

            if (!res.ok) {
                // 绘图请求：如果 503 且提示需要 /images/generations，自动重试
                if (type === 'image' && res.status === 503) {
                    const errBody = await res.text().catch(() => '')
                    if (/\/images\/generations|\/images\/edits/.test(errBody)) {
                        logger.info(`[AI-Plugin] 模型 [${provider.name} - ${modelId}] 需要 /images/generations，自动重试`)
                        try {
                            return await this._retryWithImageEndpoint(payload, provider, modelId, maxTokens, timeout)
                        } catch (retryErr) {
                            throw new Error(`自动重试失败: ${retryErr.message}`)
                        }
                    }
                }
                throw new Error(`HTTP状态码: ${res.status}`)
            }

            const responseText = await res.text()
            let data

            try {
                data = JSON.parse(responseText)
            } catch (jsonErr) {
                // 流式 SSE 响应以 "data: " 开头，避免误判 JSON 中包含 "data:" 字段的情况
                if (responseText.trimStart().startsWith('data: ') && (responseText.includes('[DONE]') || responseText.includes('"finish_reason":"stop"'))) {
                    data = this.parseStreamResponse(responseText, type)
                } else {
                    throw new Error(`无法解析的响应: ${responseText.slice(0, 200)}...`)
                }
            }

            const result = this.parseResponse(data, type)

            if (result.success) {
                return {
                    success: true,
                    data: result.data,
                    platform: `${provider.name} (${modelId})`,
                    usage: result.usage
                }
            } else {
                // 绘图请求：如果错误提示需要 /images/generations，自动重试
                if (type === 'image' && /\/images\/generations|\/images\/edits/.test(result.error || '')) {
                    logger.info(`[AI-Plugin] 模型 [${provider.name} - ${modelId}] 需要 /images/generations，自动重试`)
                    try {
                        return await this._retryWithImageEndpoint(payload, provider, modelId, maxTokens, timeout)
                    } catch (retryErr) {
                        throw new Error(`自动重试失败: ${retryErr.message}`)
                    }
                }
                // 当错误信息为空或极短时，打印原始响应以便排查
                if (!result.error || result.error.length < 5) {
                    logger.warn(`[AI-Plugin] 模型 [${provider.name} - ${modelId}] 返回空错误，原始响应: ${responseText.slice(0, 500)}`)
                }
                throw new Error(`API业务错误: ${result.error}`)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 模型 [${provider.name} - ${modelId}] 请求失败: ${err.message}`)
            return { success: false, error: err.message }
        }
    }

    /**
     * 构建 multipart/form-data 请求体（用于 /images/edits 图生图）
     * @param {Array<{name:string, value:string}>} fields - 普通表单字段
     * @param {Array<{name:string, buffer:Buffer, filename:string, contentType:string}>} files - 文件字段
     * @returns {{ headers: object, body: Buffer }}
     */
    _buildMultipartForm(fields, files) {
        const boundary = `----aiplugin-form-${Date.now()}-${Math.random().toString(16).slice(2)}`
        const chunks = []
        const push = (val) => chunks.push(Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8'))

        for (const { name, value } of fields) {
            push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
        }
        for (const { name, buffer, filename, contentType } of files) {
            push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`)
            push(buffer)
            push('\r\n')
        }
        push(`--${boundary}--\r\n`)

        const body = Buffer.concat(chunks)
        return {
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
            body
        }
    }

    /** 从 inline_data 中提取图片 buffer 和 mime type */
    _extractImageBuffers(parts) {
        const images = []
        for (const part of parts) {
            if (!part.inline_data?.data) continue
            const mimeType = part.inline_data.mime_type || 'image/png'
            const buffer = Buffer.from(part.inline_data.data, 'base64')
            images.push({ buffer, mimeType })
        }
        return images
    }

    /** 用 images/generations 或 images/edits 端点重试绘图请求 */
    async _retryWithImageEndpoint(payload, provider, modelId, _maxTokens, timeout) {
        const parts = payload.contents?.[0]?.parts || []
        const prompt = parts.map(p => p.text).filter(Boolean).join('\n') || ''
        const images = this._extractImageBuffers(parts)

        if (images.length > 0) {
            // 有参考图 → /images/edits + multipart
            const url = `${provider.base_url}/images/edits`
            const fields = [
                { name: 'model', value: modelId },
                { name: 'prompt', value: prompt },
                { name: 'n', value: '1' }
            ]
            const files = images.map((img, i) => ({
                name: 'image',
                buffer: img.buffer,
                filename: `reference_${i + 1}.${img.mimeType.split('/')[1] || 'png'}`,
                contentType: img.mimeType
            }))
            const { headers, body } = this._buildMultipartForm(fields, files)
            const options = {
                method: 'POST',
                headers: {
                    ...headers,
                    'Authorization': `Bearer ${provider.api_key}`,
                    'HTTP-Referer': 'https://yuzubot.com',
                    'X-Title': 'Yuzu-Bot'
                },
                body
            }
            if (timeout > 0) options.timeout = timeout

            logger.info(`[AI-Plugin] 模型 [${provider.name} - ${modelId}] 使用 /images/edits（${images.length} 张参考图）`)
            const res = await fetchWithProxy(url, options)
            if (!res.ok) throw new Error(`HTTP状态码: ${res.status}`)

            const responseText = await res.text()
            let data
            try {
                data = JSON.parse(responseText)
            } catch {
                throw new Error(`无法解析的响应: ${responseText.slice(0, 200)}...`)
            }

            const result = this.parseResponse(data, 'image')
            if (result.success) {
                return { success: true, data: result.data, platform: `${provider.name} (${modelId})`, usage: result.usage }
            }
            throw new Error(`API业务错误: ${result.error}`)
        }

        // 无参考图 → /images/generations + JSON（保持原有逻辑）
        const url = `${provider.base_url}/images/generations`
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.api_key}`,
                'HTTP-Referer': 'https://yuzubot.com',
                'X-Title': 'Yuzu-Bot'
            },
            body: JSON.stringify({ model: modelId, prompt, n: 1 })
        }
        if (timeout > 0) options.timeout = timeout

        const res = await fetchWithProxy(url, options)
        if (!res.ok) throw new Error(`HTTP状态码: ${res.status}`)

        const responseText = await res.text()
        let data
        try {
            data = JSON.parse(responseText)
        } catch {
            throw new Error(`无法解析的响应: ${responseText.slice(0, 200)}...`)
        }

        const result = this.parseResponse(data, 'image')
        if (result.success) {
            return { success: true, data: result.data, platform: `${provider.name} (${modelId})`, usage: result.usage }
        }
        throw new Error(`API业务错误: ${result.error}`)
    }

    async makeRequest(type, payload, modelGroupKey = 'flash', maxTokens = 8192, providerFilter = null) {
        let modelPool = this.activeModelPools[modelGroupKey]?.[type]
        const taskTypeName = type === 'image' ? '绘图' : '对话'
        let lastError = `模型组 [${modelGroupKey}] 中没有可用的 [${taskTypeName}] 模型。`

        // 数字优先级过滤：临时指定某家供应商
        if (providerFilter !== null && modelPool && modelPool.length > 0) {
            const providerName = modelPool.find(m => m.provider.priority === providerFilter)?.provider?.name || `P${providerFilter}`
            const filtered = modelPool.filter(m => m.provider.priority === providerFilter)
            if (filtered.length > 0) {
                modelPool = filtered
                logger.info(`[AI-Plugin] 数字优先级过滤: 仅使用 ${providerName}(${filtered.length}个模型)`)
            } else {
                logger.warn(`[AI-Plugin] 数字优先级 ${providerFilter} 无匹配供应商，回退到完整模型池`)
            }
        }

        // 有图片的对话请求只交给多模态模型，避免纯文本模型接收图片导致失败
        if (type === 'chat' && this._payloadHasImages(payload) && modelPool && modelPool.length > 0) {
            const multimodalPool = modelPool.filter(item => item.provider.multimodal)
            if (multimodalPool.length > 0) {
                modelPool = multimodalPool
                logger.info(`[AI-Plugin] 检测到图片输入，仅使用 ${multimodalPool.length} 个多模态对话模型`)
            } else {
                lastError = `模型组 [${modelGroupKey}] 当前筛选范围内没有可用的多模态对话模型，无法直接处理图片。请启用 Vision Relay 或选择多模态供应商。`
                logger.error(`[AI-Plugin] ${lastError}`)
                return { success: false, error: lastError }
            }
        }

        if (modelPool && modelPool.length > 0) {
            // 智能排序模型池
            const sortedPool = this._sortModelPool(modelPool)

            const cooldownCount = sortedPool.filter(s => s.score < 0).length
            const availableCount = sortedPool.filter(s => s.score >= 0).length
            logger.debug(`[AI-Plugin] 模型池: 共 ${sortedPool.length} 个, 可用 ${availableCount} 个, 熔断 ${cooldownCount} 个`)

            // 如果全部熔断，强行全部放出来
            const poolToTry = availableCount > 0
                ? sortedPool.filter(s => s.score >= 0)
                : sortedPool.map(s => ({ ...s, score: 0 }))

            lastError = ''
            for (const { provider, modelId, score } of poolToTry) {
                const statusKey = `${provider.id}-${modelId}`
                const startTime = Date.now()
                const result = await this.attemptRequest(type, payload, provider, modelId, maxTokens)
                const elapsedMs = Date.now() - startTime
                const elapsed = (elapsedMs / 1000).toFixed(2)

                if (result.success) {
                    this._recordModelSuccess(statusKey, elapsedMs)
                    this.saveModelStatus()
                    logger.debug(`[AI-Plugin] 请求成功: ${provider.name} (${modelId})，耗时 ${elapsed}s, 得分:${score?.toFixed(2)}`)
                    return result
                }

                this._recordModelFail(statusKey)
                this.saveModelStatus()
                logger.debug(`[AI-Plugin] 请求失败: ${provider.name} (${modelId})，耗时 ${elapsed}s，得分:${score?.toFixed(2)}, 错误: ${result.error}`)
                lastError += `[${provider.name}-${modelId}]: ${result.error}\n`
            }

            const errorMessage = `模型组 [${modelGroupKey}] 中的所有可用模型均尝试失败。\n具体错误:\n${lastError.trim()}`
            logger.error(`[AI-Plugin] ${errorMessage}`)
            return { success: false, error: `${errorMessage}` }
        } else {
            if (modelGroupKey !== 'flash') {
                lastError = `模型组 [${modelGroupKey}] 中没有可用的 [${taskTypeName}] 模型。请检查 models_config.yaml 配置或使用其他指令。`
            } else {
                lastError = `[默认] 模型组中也找不到可用的 [${taskTypeName}] 类型模型。请检查配置文件中的模型列表。`
            }
            logger.error(`[AI-Plugin] ${lastError}`)
            return { success: false, error: lastError }
        }
    }

    toggleModelDisabled(action, modelId) {
        const matchingModels = []
        for (const provider of this.modelsConfig) {
            for (const groupName in provider.model_groups) {
                const group = provider.model_groups[groupName]
                const allModels = [...(group.chat_models || []), ...(group.draw_models || [])]
                if (allModels.includes(modelId)) {
                    matchingModels.push({ providerId: provider.id, modelId: modelId })
                }
            }
        }

        if (matchingModels.length === 0) {
            return { success: false, message: `未找到模型ID为 "${modelId}" 的模型。` }
        }
        if (matchingModels.length > 1) {
            const providers = matchingModels.map(m => m.providerId).join(', ')
            return { success: false, message: `发现多个供应商 (${providers}) 拥有相同的模型ID "${modelId}"，无法确定要操作哪一个。` }
        }

        const { providerId, modelId: mid } = matchingModels[0]
        const statusKey = `${providerId}-${mid}`

        if (action === '禁用') {
            if (this.disabledModels.has(statusKey)) {
                return { success: false, message: `模型 ${statusKey} 已经是禁用状态了。` }
            }
            this.disabledModels.add(statusKey)
            this.saveDisabledModels()
            this._buildActiveModelPools()
            return { success: true, message: `模型 ${statusKey} 已被禁用，并已从可用模型池中移除。` }
        } else {
            if (!this.disabledModels.has(statusKey)) {
                return { success: false, message: `模型 ${statusKey} 当前未被禁用。` }
            }
            this.disabledModels.delete(statusKey)
            this.saveDisabledModels()
            this._buildActiveModelPools()

            return { success: true, message: `模型 ${statusKey} 已被启用并立即激活！` }
        }
    }

    reload() {
        this.loadModelsConfig()
        toolRegistry.setWeatherApiKey(this.weatherApiKey)
        toolRegistry.setOpenWeatherMapApiKey(this.openWeatherMapApiKey)
        this.loadModelStatus()
        this.loadDisabledModels()
        this._buildActiveModelPools()
    }
}
