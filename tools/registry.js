/**
 * AI-Plugin 工具注册表
 * 管理所有内置工具，支持 Function Calling schema 生成和结果格式化
 */

class ToolRegistry {
    constructor() {
        this.tools = new Map()
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
    async execute(name, args) {
        const tool = this.tools.get(name)
        if (!tool) {
            throw new Error(`未知工具: ${name}`)
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
     * 用轻量 LLM 分析用户消息是否需要搜索
     * @param {string} userMessage - 用户消息文本
     * @param {object} client - AiClient 实例
     * @returns {{ needsSearch: boolean, queries: string[] } | null}
     */
    async analyzeSearchIntent(userMessage, client) {
        if (!userMessage || !userMessage.trim()) return null

        const now = new Date()
        const currentYear = now.getFullYear()
        const currentMonth = now.getMonth() + 1

        const analysisPrompt = `当前时间是${currentYear}年${currentMonth}月。你是一个搜索策略分析助手。请分析用户的消息，判断是否需要通过搜索引擎获取额外信息。

        分析规则：
        - 如果内容是常识性问题、日常闲聊、情感倾诉或无需联网即可回答的问题，设置 needsSearch 为 false
        - 如果内容涉及近期事件、新闻、具体实时数据、事实核查等需要查证的信息，设置 needsSearch 为 true
        - 每个搜索关键词不超过30个字
        - 最多提供3个搜索关键词
        - 如果消息中提到"最近"、"近期"等时间词，请替换为"${currentYear}年${currentMonth}月"

        请严格按以下JSON格式输出，不要输出其他任何内容：
        {"needsSearch": true或false, "queries": ["关键词1", "关键词2"]}`

        try {
            const analysisPayload = {
                contents: [
                    { role: "user", parts: [{ text: analysisPrompt + `\n\n用户消息：\n${userMessage}` }] }
                ]
            }

            // 使用 flash 模型组做快速分析
            const result = await client.makeRequest('chat', analysisPayload, 'flash', 512)
            if (!result.success || !result.data) {
                logger.warn('[AI-Plugin] 搜索意图分析 LLM 调用失败')
                return null
            }

            const analysisText = result.data.trim()
            logger.info(`[AI-Plugin] 搜索意图分析 模型返回: "${analysisText.slice(0, 200)}"`)

            const jsonMatch = analysisText.match(/\{[\s\S]*\}/)
            if (!jsonMatch) {
                logger.warn('[AI-Plugin] 搜索意图分析 未找到JSON')
                return null
            }

            const parsed = JSON.parse(jsonMatch[0])
            const needsSearch = parsed.needsSearch === true
            const queries = Array.isArray(parsed.queries)
                ? parsed.queries.filter(q => q && q.trim()).slice(0, 3)
                : []

            logger.info(`[AI-Plugin] 搜索意图分析 needsSearch=${needsSearch}, queries=${JSON.stringify(queries)}`)
            return { needsSearch, queries }
        } catch (err) {
            logger.warn('[AI-Plugin] 搜索意图分析 失败:', err)
            return null
        }
    }
}

export const toolRegistry = new ToolRegistry()