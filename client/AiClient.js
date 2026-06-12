import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'
import { Config, MODELS_CONFIG_FILE, MODEL_STATUS_FILE, DISABLED_MODELS_FILE, TEMPLATE_DIR_EXPORT } from '../utils/config.js'
import { fetchWithProxy } from '../utils/common.js'

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
        this.visionRelayConfig = { enable_vision_relay: false, vision_model: null }
        this.loadModelsConfig()
        this.loadModelStatus()
        this.loadDisabledModels()
        this._buildActiveModelPools()
    }

    /** 是否启用图文转述 */
    get enableVisionRelay() {
        return this.visionRelayConfig?.enable_vision_relay === true &&
               !!this.visionRelayConfig?.vision_model?.provider_id &&
               !!this.visionRelayConfig?.vision_model?.model_id
    }

    /** Vision 模型配置 */
    get visionModel() {
        return this.visionRelayConfig?.vision_model || null
    }

    /** 初始化模型状态条目（兼容旧格式） */
    _initModelStatusEntry(key) {
        const entry = this.modelStatus[key]
        if (!entry) {
            this.modelStatus[key] = {
                status: 'unknown',
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
        entry.status = 'ok'
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
        entry.status = 'failed'
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

    /** 智能排序模型池：分高者优先，排除熔断模型 */
    _sortModelPool(pool) {
        const now = Date.now()
        const scored = pool.map(item => {
            const key = `${item.provider.id}-${item.modelId}`
            if (!this.modelStatus[key]) this._initModelStatusEntry(key)
            return { ...item, score: this._getModelScore(this.modelStatus[key]) }
        })

        // 按得分降序排列
        scored.sort((a, b) => b.score - a.score)

        const logging = scored.map(s =>
            `${s.provider.name}(${s.modelId}) 得分:${s.score.toFixed(2)}`
        ).join(', ')
        logger.debug(`[AI-Plugin] 模型排序: ${logging}`)

        return scored
    }

    loadModelsConfig() {
        this.modelsConfig = []
        this.visionRelayConfig = { enable_vision_relay: false, vision_model: null }
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
            // 支持多文档 YAML：第一个文档为供应商列表，第二个为 Vision Relay 配置
            const allDocs = yaml.parseAllDocuments(fileContent)
            const providersDoc = allDocs[0]
            const visionDoc = allDocs[1]

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
                if (visionConfig && typeof visionConfig === 'object') {
                    this.visionRelayConfig = visionConfig
                    if (this.enableVisionRelay) {
                        logger.info(`[AI-Plugin] Vision Relay 已启用: ${visionConfig.vision_model.provider_id}/${visionConfig.vision_model.model_id}`)
                    } else {
                        logger.debug('[AI-Plugin] Vision Relay 未启用或配置不完整')
                    }
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

    _buildActiveModelPools() {
        this.activeModelPools = {}

        for (const provider of this.modelsConfig) {
            for (const groupName in provider.model_groups) {
                if (!this.activeModelPools[groupName]) {
                    this.activeModelPools[groupName] = { chat: [], image: [] }
                }
            }
        }

        if (!this.modelStatus || Object.keys(this.modelStatus).length === 0) {
            logger.warn('[AI-Plugin] 未找到模型测试状态，可用模型池为空。')
            return
        }

        for (const provider of this.modelsConfig) {
            for (const groupName in provider.model_groups) {
                const group = provider.model_groups[groupName]

                if (group.chat_models) {
                    for (const modelId of group.chat_models) {
                        const statusKey = `${provider.id}-${modelId}`
                        this._initModelStatusEntry(statusKey)
                        if (this.modelStatus[statusKey]?.status === 'ok') {
                            this.activeModelPools[groupName].chat.push({ provider, modelId })
                        }
                    }
                }
                if (group.draw_models) {
                    for (const modelId of group.draw_models) {
                        const statusKey = `${provider.id}-${modelId}`
                        this._initModelStatusEntry(statusKey)
                        if (this.modelStatus[statusKey]?.status === 'ok') {
                            this.activeModelPools[groupName].image.push({ provider, modelId })
                        }
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

    parseResponse(data, type) {
        if (data.error) {
            const errorMsg = data.error.message || data.error || '未知错误'
            return { success: false, error: typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg) }
        }

        const usage = data.usage || null

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

    async attemptRequest(type, payload, provider, modelId, maxTokens = 8192) {
        try {
            const { url, options } = this.buildRequest(type, payload, provider, modelId, maxTokens)
            
            // 检查请求体大小，防止 413 错误
            const bodySize = Buffer.byteLength(options.body, 'utf8')
            if (bodySize > 10 * 1024 * 1024) { // 10MB 警告阈值
                logger.warn(`[AI-Plugin] 请求体过大 (${(bodySize / 1024 / 1024).toFixed(2)}MB)，可能导致 413 错误`)
            }
            
            const res = await fetchWithProxy(url, options)

            if (!res.ok) {
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

    async makeRequest(type, payload, modelGroupKey = 'flash', maxTokens = 8192) {
        const modelPool = this.activeModelPools[modelGroupKey]?.[type]
        const taskTypeName = type === 'image' ? '绘图' : '对话'
        let lastError = `模型组 [${modelGroupKey}] 中没有可用的 [${taskTypeName}] 模型。`

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
            return { success: false, error: `${errorMessage}\n建议运行 #ai模型测试。` }
        } else {
            if (modelGroupKey !== 'flash') {
                lastError = `模型组 [${modelGroupKey}] 中没有可用的 [${taskTypeName}] 模型。请检查 models_config.yaml 配置或使用其他指令。`
            } else {
                lastError = `[默认] 模型组中也找不到可用的 [${taskTypeName}] 类型模型。请运行 #ai模型测试 来更新可用模型列表。`
            }
            logger.error(`[AI-Plugin] ${lastError}`)
            return { success: false, error: lastError }
        }
    }

    async testSingleModel(provider, modelId, type) {
        const startTime = Date.now()
        const statusKey = `${provider.id}-${modelId}`

        const testPrompt = "This is an API connectivity test. Please reply with 'OK' in text only, and do not generate any images."
        const payload = { "contents": [{ "role": "user", "parts": [{ "text": testPrompt }] }] }

        try {
            const { url, options } = this.buildRequest(type, payload, provider, modelId)
            const bodyObj = JSON.parse(options.body)
            bodyObj.stream = false
            options.body = JSON.stringify(bodyObj)

            const res = await fetchWithProxy(url, { ...options, timeout: 64000 })

            if (!res.ok) throw new Error(`HTTP状态码: ${res.status}`)

            let data
            try {
                data = await res.json()
                if (data.error) {
                    throw new Error(data.error.message || 'API返回了错误信息')
                }
            } catch (e) {
                const responseText = await res.text()
                const hasError = /"error"/.test(responseText)
                const hasDoneSignal = /data: \[DONE\]/.test(responseText) || /"finish_reason":"stop"/.test(responseText)

                if (hasError || !hasDoneSignal) {
                    const errorMessage = e.message.includes('Invalid JSON') ? responseText : e.message
                    throw new Error(`流式响应异常或包含错误: ${errorMessage.slice(0, 200)}...`)
                }
                data = {}
            }

            const responseTime = Date.now() - startTime

            this._initModelStatusEntry(statusKey)
            this.modelStatus[statusKey] = {
                ...this.modelStatus[statusKey],
                status: 'ok',
                responseTime,
                usage: data.usage || null,
                lastTested: new Date().toISOString()
            }

            return { success: true }
        } catch (error) {
            const responseTime = Date.now() - startTime
            this._initModelStatusEntry(statusKey)
            this.modelStatus[statusKey] = {
                ...this.modelStatus[statusKey],
                status: 'failed',
                error: error.message,
                responseTime,
                lastTested: new Date().toISOString()
            }
            logger.warn(`[AI-Plugin] 测试模型 [${provider.name}] ${modelId} 失败: ${error.message}`)
            return { success: false }
        }
    }

    async testAllModels() {
        this.modelStatus = {}
        const testPromises = []
        let totalModels = 0
        let skippedCount = 0

        for (const provider of this.modelsConfig) {
            for (const groupName in provider.model_groups) {
                const group = provider.model_groups[groupName]

                const modelsToTest = [
                    ...(group.chat_models || []).map(modelId => ({ modelId, type: 'chat' })),
                    ...(group.draw_models || []).map(modelId => ({ modelId, type: 'image' }))
                ]

                for (const { modelId, type } of modelsToTest) {
                    totalModels++
                    const statusKey = `${provider.id}-${modelId}`

                    if (this.disabledModels.has(statusKey)) {
                        skippedCount++
                        continue
                    }

                    testPromises.push(this.testSingleModel(provider, modelId, type))
                }
            }
        }

        if (totalModels === 0) {
            return { total: 0, success: 0, failed: 0, skipped: 0 }
        }

        if (testPromises.length > 0) {
            const CONCURRENCY_LIMIT = Config.TEST_CONCURRENCY_LIMIT
            logger.info(`[AI-Plugin] 开始测试 ${testPromises.length} 个模型，每批并发 ${CONCURRENCY_LIMIT} 个`)
            const startTime = Date.now()
            for (let i = 0; i < testPromises.length; i += CONCURRENCY_LIMIT) {
                const batch = testPromises.slice(i, i + CONCURRENCY_LIMIT)
                await Promise.all(batch)
            }
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            logger.info(`[AI-Plugin] 模型测试完成，耗时 ${elapsed}s`)
        }

        let successCount = 0
        for (const status of Object.values(this.modelStatus)) {
            if (status.status === 'ok') {
                successCount++
            }
        }
        this.saveModelStatus()
        this._buildActiveModelPools()

        return {
            total: totalModels,
            success: successCount,
            failed: testPromises.length - successCount,
            skipped: skippedCount
        }
    }

    enableAllModels() {
        if (!this.modelsConfig || this.modelsConfig.length === 0) {
            return { success: false, message: "尚未加载任何模型配置" }
        }

        let count = 0
        const now = new Date().toISOString()

        for (const provider of this.modelsConfig) {
            for (const groupName in provider.model_groups) {
                const group = provider.model_groups[groupName]
                const allModelsInGroup = [
                    ...(group.chat_models || []),
                    ...(group.draw_models || [])
                ]

                for (const modelId of allModelsInGroup) {
                    const statusKey = `${provider.id}-${modelId}`

                    this._initModelStatusEntry(statusKey)
                    this.modelStatus[statusKey].status = 'ok'
                    this.modelStatus[statusKey].lastTested = now

                    if (this.disabledModels.has(statusKey)) {
                        this.disabledModels.delete(statusKey)
                    }

                    count++
                }
            }
        }

        this.saveModelStatus()
        this.saveDisabledModels()
        this._buildActiveModelPools()

        return { success: true, count, message: `已成功将 ${count} 个模型全部设为"可用"状态！` }
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
            if (this.modelStatus[statusKey]?.status === 'ok') {
                delete this.modelStatus[statusKey]
                this.saveModelStatus()
            }
            this._buildActiveModelPools()
            return { success: true, message: `模型 ${statusKey} 已被禁用，并已从可用模型池中移除。` }
        } else {
            if (!this.disabledModels.has(statusKey)) {
                return { success: false, message: `模型 ${statusKey} 当前未被禁用。` }
            }
            this.disabledModels.delete(statusKey)
            this.saveDisabledModels()

            this._initModelStatusEntry(statusKey)
            this.modelStatus[statusKey].status = 'ok'
            this.modelStatus[statusKey].lastTested = new Date().toISOString()
            this.saveModelStatus()
            this._buildActiveModelPools()

            return { success: true, message: `模型 ${statusKey} 已被启用并立即激活！` }
        }
    }

    reload() {
        this.loadModelsConfig()
        this.loadModelStatus()
        this.loadDisabledModels()
        this._buildActiveModelPools()
    }
}
