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

    /** 检测用户消息是否需要工具辅助（简单关键词匹配） */
    detectToolIntent(msg) {
        const searchPatterns = [
            /搜索[：:]\s*(.+)/,
            /查[一一下]?\s*(.+)/,
            /帮我查[一一下]?\s*(.+)/,
            /搜[一一下]?\s*(.+)/,
        ]
        for (const pattern of searchPatterns) {
            const match = msg.match(pattern)
            if (match) {
                return { tool: 'web_search', args: { query: match[1] } }
            }
        }
        return null
    }
}

export const toolRegistry = new ToolRegistry()