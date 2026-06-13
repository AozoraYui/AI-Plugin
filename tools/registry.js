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
     * 检测用户消息是否询问服务器系统状态（关键词匹配）
     */
    detectSystemInfoIntent(msg) {
        if (!msg || !msg.trim()) return false
        const patterns = [
            /服务器.*(状态|信息|情况|怎么样|好不好|还行吗)/,
            /(查看|看看|查一下|帮我看看|帮我查).*(服务器|机器|主机)/,
            /(CPU|内存|温度|负载|硬盘|磁盘|运行时间|频率|进程).*(多少|怎么样|如何)/,
            /(温度|散热).*(高不高|多少|怎么样)/,
            /(系统|服务器).*(信息|状态|负载|健康)/,
        ]
        return patterns.some(p => p.test(msg))
    }

    /**
     * 检测并提取文件读取意图（关键词匹配 + 路径提取）
     * @returns {{ path: string } | null}
     */
    detectFileReadIntent(msg) {
        if (!msg || !msg.trim()) return null
        const patterns = [
            /(?:帮我|请|给|来)?(?:读|读取|查看|看看|打开)(?:一下)?(?:这个|文件)?\s*(?:\/[\w\.\-\/]+)/,
            /文件\s*(?:\/[\w\.\-\/]+)/,
        ]
        for (const p of patterns) {
            const match = msg.match(p)
            if (match) {
                const pathMatch = msg.match(/(\/[\w\.\-\/]+)/)
                if (pathMatch) return { path: pathMatch[1] }
            }
        }
        return null
    }

    /**
     * 检测并提取目录读取意图（关键词匹配 + 路径提取）
     * @returns {{ path: string } | null}
     */
    detectDirReadIntent(msg) {
        if (!msg || !msg.trim()) return null
        const patterns = [
            /(?:帮我|请|给|来)?(?:列出|浏览|看看|查看)(?:一下)?(?:目录|文件夹|里面的东西|里面有什么)\s*(?:\/[\w\.\-\/]+)/,
            /(?:列出|浏览)(?:目录)?\s*(?:\/[\w\.\-\/]+)/,
            /目录\s*(?:\/[\w\.\-\/]+)/,
        ]
        for (const p of patterns) {
            const match = msg.match(p)
            if (match) {
                const pathMatch = msg.match(/(\/[\w\.\-\/]+)/)
                if (pathMatch) return { path: pathMatch[1] }
            }
        }
        return null
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

            let result = null

            // 优先使用配置的意图分析专用模型（绕过模型池，直接调用，15s 超时）
            if (client.webSearchIntentModels.length > 0) {
                result = await client.quickIntentRequest(analysisPayload)
                if (!result?.success) {
                    logger.warn('[AI-Plugin] 专用意图分析模型均失败，降级到 Flash 模型组')
                }
            }

            // 降级：使用 Flash 模型组做意图分析
            if (!result?.success) {
                result = await client.makeRequest('chat', analysisPayload, 'flash', 256)
            }

            if (!result.success || !result.data) {
                logger.warn('[AI-Plugin] 搜索意图分析 LLM 调用失败')
                return null
            }

            const analysisText = result.data.trim()
            const modelInfo = result.platform ? ` [${result.platform}]` : ''
            logger.info(`[AI-Plugin] 搜索意图分析${modelInfo} 返回: "${analysisText.slice(0, 200)}"`)

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