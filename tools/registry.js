/**
 * AI-Plugin 工具注册表
 * 管理所有内置工具，支持 Function Calling schema 生成和结果格式化
 */

class ToolRegistry {
    constructor() {
        this.tools = new Map()
        this.weatherApiKey = null
    }

    /** 设置天气 API Key（由 AiClient 初始化时调用） */
    setWeatherApiKey(apiKey) {
        this.weatherApiKey = apiKey
    }

    /** 注册一个工具 */
    register(tool) {
        if (!tool.name || !tool.execute) {
            throw new Error('Tool must have name and execute method')
        }
        this.tools.set(tool.name, tool)
        logger.info(`[AI-Plugin] 工具已注册: ${tool.name}`)
    }

    /** 获取工具 */
    get(name) {
        return this.tools.get(name)
    }

    /** 获取所有工具名 */
    getToolNames() {
        return [...this.tools.keys()]
    }

    /** 生成 Function Calling schema（给支持 FC 的模型用） */
    getFunctionSchemas() {
        return [...this.tools.values()]
            .filter(t => t.functionSchema)
            .map(t => t.functionSchema)
    }

    /** 执行工具调用 */
    async execute(name, args, isMaster = false) {
        const tool = this.tools.get(name)
        if (!tool) {
            throw new Error(`未知工具: ${name}`)
        }

        // 权限检查：permission 为 'master' 的工具仅主人可调用
        if (tool.permission === 'master' && !isMaster) {
            logger.warn(`[AI-Plugin] 工具 ${name} 权限不足：非主人尝试调用`)
            return { success: false, error: '权限不足：此工具仅限机器人主人使用' }
        }

        logger.info(`[AI-Plugin] 调用工具: ${name}, 参数: ${JSON.stringify(args)}`)
        try {
            const result = await tool.execute(args)
            logger.info(`[AI-Plugin] 工具 ${name} 执行成功`)
            return { success: true, data: result }
        } catch (err) {
            logger.error(`[AI-Plugin] 工具 ${name} 执行失败:`, err)
            return { success: false, error: err.message }
        }
    }

    /** 格式化工具结果为文本（注入到 prompt） */
    formatToolResult(name, data) {
        const tool = this.tools.get(name)
        if (tool?.formatResult) {
            return tool.formatResult(data)
        }
        return JSON.stringify(data, null, 2)
    }

    /**
     * LLM 工具路由：统一分析用户消息，决定需要调用哪些工具
     * 替代原有的关键词匹配意图检测，用 deepseek-v4-flash 做智能路由
     * @param {string} userMessage - 用户消息文本
     * @param {object} client - AiClient 实例
     * @param {string[]} enabledTools - 当前可用的工具名列表
     * @returns {Array<{name: string, args: object}>} 工具调用列表
     */
    async analyzeToolIntent(userMessage, client, enabledTools = []) {
        if (!userMessage || !userMessage.trim() || enabledTools.length === 0) return []

        const now = new Date()

        // 构建工具描述
        const toolDescriptions = []
        for (const name of enabledTools) {
            const tool = this.tools.get(name)
            if (!tool) continue
            const permNote = tool.permission === 'master' ? ' (仅主人)' : ''
            toolDescriptions.push(`- ${tool.name}${permNote}: ${tool.description || ''}`)
        }

        const analysisPrompt = `当前时间：${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日。你是一个意图分析助手。分析用户消息，输出意图分析和需要调用的工具。

可用工具：
${toolDescriptions.join('\n')}

各工具参数格式：
- web_search: {"query": "搜索关键词"}
- system_info: {}
- weather: {"city": "城市名"}
- file_read: {"path": "/绝对路径", "read_all": true或false}
- dir_read: {"path": "/绝对路径", "read_all": true或false}
- web_fetch: {"url": "完整URL"}

请严格按以下JSON格式输出，不要输出其他任何内容：
{"intent": "用户意图分析（一句话概括用户想做什么、隐含需求等）", "tools": [{"tool": "工具名", "params": {...}}]}

规则：
- 如果用户消息不需要任何工具，tools 返回空数组 []
- intent 字段必填，简要分析用户意图
- 只使用上述"可用工具"列表中列出的工具，不要调用未列出的工具
- 路径必须是绝对路径，从用户消息中提取
- 搜索关键词要求精确、简洁，不超过30字`

        try {
            const analysisPayload = {
                contents: [
                    { role: "user", parts: [{ text: analysisPrompt + `\n\n用户消息：\n${userMessage}` }] }
                ]
            }

            let result = null

            // 优先使用配置的意图分析专用模型（deepseek-v4-flash 等）
            if (client.webSearchIntentModels.length > 0) {
                result = await client.quickIntentRequest(analysisPayload)
                if (!result?.success) {
                    logger.warn('[AI-Plugin] 工具路由专用模型均失败，降级到 Flash 模型组')
                }
            }

            // 降级：使用 Flash 模型组
            if (!result?.success) {
                result = await client.makeRequest('chat', analysisPayload, 'flash', 256)
            }

            if (!result.success || !result.data) {
                logger.warn('[AI-Plugin] 工具路由 LLM 调用失败')
                return []
            }

            const analysisText = result.data.trim()
            const modelInfo = result.platform ? ` [${result.platform}]` : ''
            logger.info(`[AI-Plugin] 工具路由${modelInfo} 返回: "${analysisText.slice(0, 300)}"`)

            // 兼容两种 JSON 格式：数组 [{...}] 或对象 {tools: [...]}
            // 注意：必须先匹配数组再匹配对象，否则 [{...}] 中的内层 {} 会被先捕获
            let parsed = null
            const arrMatch = analysisText.match(/\[[\s\S]*\]/)
            if (arrMatch) {
                try { parsed = JSON.parse(arrMatch[0]) } catch (_) { /* 继续尝试对象 */ }
            }
            if (!parsed) {
                const objMatch = analysisText.match(/\{[\s\S]*\}/)
                if (objMatch) {
                    try { parsed = JSON.parse(objMatch[0]) } catch (_) { /* 失败 */ }
                }
            }
            if (!parsed) {
                logger.warn('[AI-Plugin] 工具路由 JSON 解析失败')
                return []
            }

            // 标准化：数组直接作为工具列表，对象取 .tools 字段
            // 如果 parsed 是单个工具对象（如 {"tool": "weather", "params": {...}}），包装为数组
            let tools = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.tools) ? parsed.tools : [])
            if (tools.length === 0 && parsed && typeof parsed === 'object' && (parsed.tool || parsed.name)) {
                tools = [parsed]
            }

            // 标准化字段名：兼容 tool→name, params→args
            tools = tools.map(t => ({
                name: t.name || t.tool,
                args: t.args || t.params || t.parameters || t.arguments || {}
            }))

            // 提取意图分析
            const intent = parsed.intent || ''

            // 过滤非法工具调用
            const validCalls = tools.filter(t => {
                if (!t.name || !enabledTools.includes(t.name)) {
                    logger.warn(`[AI-Plugin] 工具路由 忽略非法工具: ${t.name}`)
                    return false
                }
                return true
            })

            logger.info(`[AI-Plugin] 工具路由 决定调用 ${validCalls.length} 个工具: ${validCalls.map(t => t.name).join(', ')}`)
            return { intent, tools: validCalls }
        } catch (err) {
            logger.warn('[AI-Plugin] 工具路由 失败:', err)
            return { intent: '', tools: [] }
        }
    }
}

export const toolRegistry = new ToolRegistry()