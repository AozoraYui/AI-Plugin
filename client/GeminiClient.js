import fs from 'node:fs'
import yaml from 'yaml'
import { Config, MODELS_CONFIG_FILE, MODEL_STATUS_FILE, DISABLED_MODELS_FILE } from '../utils/config.js'
import { fetchWithProxy } from '../utils/common.js'

export class GeminiClient {
    constructor() {
        this.modelsConfig = []
        this.modelStatus = {}
        this.disabledModels = new Set()
        this.activeModelPools = {}
        this.loadModelsConfig()
        this.loadModelStatus()
        this.loadDisabledModels()
        this._buildActiveModelPools()
    }

    loadModelsConfig() {
        this.modelsConfig = []
        if (!fs.existsSync(MODELS_CONFIG_FILE)) {
            logger.warn(`[AI-Plugin] 未找到模型配置文件，将在 ${MODELS_CONFIG_FILE} 创建示例文件。`)
            const defaultConfig = `# AI 插件模型供应商配置
# 每个供应商包含以下字段：
#   id: 供应商标识（唯一）
#   name: 供应商显示名称
#   base_url: API 基础地址
#   api_key: API 密钥
#   model_groups: 模型组配置
#     default: 默认模型组（用于 #gm, #bnn 等指令）
#     pro: Pro 模型组（用于 #progm 指令）
#     gemini3: Gemini 3 模型组（用于 #3gm, #3bnn 指令）
#   每个模型组包含：
#     chat_models: 对话模型列表
#     draw_models: 绘图模型列表

- id: "your-provider-id"
  name: "供应商名称"
  base_url: "https://api.example.com/v1"
  api_key: "your-api-key-here"
  model_groups:
    # 默认组 (Flash): 用于 #gm, #bnn 等指令
    default:
      chat_models:
        - "gemini-2.5-flash"
      draw_models:
        - "gemini-2.5-flash-image"

    # 专业组 (Pro): 用于 #progm 指令
    pro:
      chat_models:
        - "gemini-2.5-pro"
      draw_models: []

    # 旗舰组 (Gemini 3): 用于 #3gm, #3bnn 等指令
    gemini3:
      chat_models:
        - "gemini-3-pro"
      draw_models: []
`
            fs.writeFileSync(MODELS_CONFIG_FILE, defaultConfig, 'utf8')
            return
        }

        try {
            const fileContent = fs.readFileSync(MODELS_CONFIG_FILE, 'utf8')
            const configs = yaml.parse(fileContent)
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
                throw new Error("模型配置文件格式不正确，应为YAML数组。")
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
            logger.info(`[AI-Plugin] 未找到模型状态文件，将在 ${MODEL_STATUS_FILE} 创建默认文件。`)
            this.modelStatus = {}
            const defaultModelStatus = `{
  "_comment": "模型测试状态文件，由插件自动管理",
  "_format": "键名格式: 供应商ID-模型ID, 值包含 status(状态), responseTime(响应时间), usage(用量), lastTested(最后测试时间)"
}`
            fs.writeFileSync(MODEL_STATUS_FILE, defaultModelStatus, 'utf8')
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
                logger.info(`[AI-Plugin] 未找到禁用模型列表文件，将在 ${DISABLED_MODELS_FILE} 创建默认文件。`)
                this.disabledModels = new Set()
                const defaultDisabledModels = `[]`
                fs.writeFileSync(DISABLED_MODELS_FILE, defaultDisabledModels, 'utf8')
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
                        if (this.modelStatus[statusKey]?.status === 'ok') {
                            this.activeModelPools[groupName].chat.push({ provider, modelId })
                        }
                    }
                }
                if (group.draw_models) {
                    for (const modelId of group.draw_models) {
                        const statusKey = `${provider.id}-${modelId}`
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

    convertToOpenAIMessages(geminiPayload) {
        const messages = []
        for (const content of geminiPayload.contents) {
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
            return { success: false, error: data.error.message }
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
            generatedImageUrl = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
                data?.choices?.[0]?.message?.images?.[0]?.url
            if (!generatedImageUrl) {
                const responseText = data?.choices?.[0]?.message?.content || ""
                const imageUrlMatch = responseText.match(/!\[.*?\]\((.*?)\)/)
                if (imageUrlMatch && imageUrlMatch[1]) {
                    generatedImageUrl = imageUrlMatch[1]
                }
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
                if (responseText.includes('data: ') && (responseText.includes('[DONE]') || responseText.includes('"finish_reason":"stop"'))) {
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
                throw new Error(`API业务错误: ${result.error}`)
            }
        } catch (err) {
            logger.error(`[AI-Plugin] 模型 [${provider.name} - ${modelId}] 请求失败: ${err.message}`)
            return { success: false, error: err.message }
        }
    }

    async makeRequest(type, payload, modelGroupKey = 'default', maxTokens = 8192) {
        const modelPool = this.activeModelPools[modelGroupKey]?.[type]
        const taskTypeName = type === 'image' ? '绘图' : '对话'
        let lastError = `模型组 [${modelGroupKey}] 中没有可用的 [${taskTypeName}] 模型。`

        if (modelPool && modelPool.length > 0) {
            logger.debug(`[AI-Plugin] 将从 [${modelGroupKey}] 模型组的 [${taskTypeName}] 池中（共 ${modelPool.length} 个模型）依次尝试...`)
            lastError = ''
            for (const { provider, modelId } of modelPool) {
                const result = await this.attemptRequest(type, payload, provider, modelId, maxTokens)
                if (result.success) {
                    return result
                }
                lastError += `[${provider.name}-${modelId}]: ${result.error}\n`
            }

            const errorMessage = `模型组 [${modelGroupKey}] 中的所有可用模型均尝试失败。\n具体错误:\n${lastError.trim()}`
            logger.error(`[AI-Plugin] ${errorMessage}`)
            return { success: false, error: `${errorMessage}\n建议运行 #gemini模型测试。` }
        } else {
            if (modelGroupKey !== 'default') {
                lastError = `模型组 [${modelGroupKey}] 中没有可用的 [${taskTypeName}] 模型。请检查 models_config.yaml 配置或使用其他指令。`
            } else {
                lastError = `[默认] 模型组中也找不到可用的 [${taskTypeName}] 类型模型。请运行 #gemini模型测试 来更新可用模型列表。`
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

            this.modelStatus[statusKey] = {
                status: 'ok',
                responseTime,
                usage: data.usage || null,
                lastTested: new Date().toISOString()
            }

            return { success: true }
        } catch (error) {
            const responseTime = Date.now() - startTime
            this.modelStatus[statusKey] = {
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
            await Promise.all(testPromises)
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
        const pseudoSuccessStatus = {
            status: 'ok',
            responseTime: null,
            usage: null,
            lastTested: now
        }

        for (const provider of this.modelsConfig) {
            for (const groupName in provider.model_groups) {
                const group = provider.model_groups[groupName]
                const allModelsInGroup = [
                    ...(group.chat_models || []),
                    ...(group.draw_models || [])
                ]

                for (const modelId of allModelsInGroup) {
                    const statusKey = `${provider.id}-${modelId}`

                    this.modelStatus[statusKey] = pseudoSuccessStatus

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

            const pseudoSuccessStatus = {
                status: 'ok',
                responseTime: null,
                usage: null,
                lastTested: new Date().toISOString()
            }
            this.modelStatus[statusKey] = pseudoSuccessStatus
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
