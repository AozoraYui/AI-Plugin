/**
 * AI-Plugin 工具注册表
 * 管理所有内置工具，支持 Function Calling schema 生成和结果格式化
 */

class ToolRegistry {
    constructor() {
        this.tools = new Map()
        this.weatherApiKey = null
        this.openWeatherMapApiKey = null
    }

    _hasExplicitWebSearchIntent(text) {
        return /(搜索|搜一下|查一下|查询|联网|上网|最新|新闻|资料|百科|官网|价格|汇率|天气|在哪里|附近|周边|推荐.*(?:店|餐厅|酒店|景点)|(?:店|餐厅|酒店|景点).*推荐)/i.test(String(text || ''))
    }

    _isWeatherRequest(text) {
        return /(天气|气温|温度|下雨|下雪|预报|冷不冷|热不热|带伞|穿什么)/i.test(String(text || ''))
    }

    _cleanWeatherCityCandidate(raw) {
        let value = String(raw || '').trim()
        value = value
            .replace(/^[,，。；;、\s"'“”‘’()（）【】]+|[,，。；;、\s"'“”‘’()（）【】]+$/g, '')
            .replace(/^(?:中国|国内|国外|城市|地区|地点|位置|所在地|常住地|现居地|住址|在|到|去|查|查一下|一下|查询|看看?|帮我|明天|今天|后天|今晚|现在|当前)+/i, '')
            .replace(/(?:明天|今天|后天|今晚|现在|当前).*$/i, '')
            .replace(/(?:的)?(?:天气|气温|温度|预报|下雨|下雪|冷不冷|热不热|带伞|穿什么).*$/i, '')
            .trim()

        value = value.replace(/^(?:在|是|为|:|：)+/, '').trim()
        value = value.replace(/^(?:广东|浙江|江苏|四川|湖北|湖南|陕西|河南|山东|福建|安徽|江西|辽宁|吉林|黑龙江|云南|贵州|广西|海南|甘肃|宁夏|青海|新疆|西藏|内蒙古|山西|河北|台湾)省?/, '').trim()
        value = value.replace(/(?:这边|那里|这里|附近|周边|本地|当地)$/i, '').trim()

        if (!value || value.length < 2 || value.length > 40) return ''
        if (/[#@<>{}\[\]`$\\/]/.test(value)) return ''
        if (/(明天|今天|后天|现在|当前|天气|气温|温度|哪里|哪儿|哪个|什么|一下|帮我|查询|群聊|消息|上下文|记忆|用户|AI)/i.test(value)) return ''

        const knownCities = new Set([
            '北京', '上海', '天津', '重庆', '广州', '深圳', '中山', '珠海', '佛山', '东莞', '惠州', '杭州', '宁波', '南京', '苏州', '无锡', '成都', '武汉', '长沙', '西安', '郑州', '济南', '青岛', '厦门', '福州', '合肥', '南昌', '沈阳', '大连', '哈尔滨', '长春', '昆明', '贵阳', '南宁', '海口', '兰州', '银川', '西宁', '乌鲁木齐', '拉萨', '呼和浩特', '太原', '石家庄', '香港', '澳门', '台北'
        ])
        if (/^[a-zA-Z][a-zA-Z\s,.'-]{1,39}$/.test(value)) return value.replace(/\s+/g, ' ')
        if (knownCities.has(value.replace(/[市县区]$/, ''))) return value.replace(/[市县区]$/, '')
        if (/^[\u4e00-\u9fa5]{2,12}(?:省|市|县|区|州|盟|旗|镇)$/.test(value)) return value.replace(/[省市县区镇]$/, '')
        if (/^[\u4e00-\u9fa5]{2,6}$/.test(value) && knownCities.has(value)) return value
        return ''
    }

    _extractWeatherCityHints(userMessage = '', memorySummary = '', recentHistory = []) {
        const hints = []
        const add = (raw) => {
            const city = this._cleanWeatherCityCandidate(raw)
            if (city && !hints.includes(city)) hints.push(city)
        }

        const currentText = String(userMessage || '')
        const explicitPatterns = [
            /(?:查|查询|看看?|帮我查|天气|气温|温度|预报).{0,10}?([a-zA-Z][a-zA-Z\s,.'-]{1,39}|[\u4e00-\u9fa5]{2,12}?)(?:明天|今天|后天|今晚|未来)?(?:的)?(?:天气|气温|温度|预报|下雨|下雪)/gi,
            /([a-zA-Z][a-zA-Z\s,.'-]{1,39}|[\u4e00-\u9fa5]{2,12}?)(?:明天|今天|后天|今晚|未来)(?:的)?(?:天气|气温|温度|预报|下雨|下雪)/gi,
            /([a-zA-Z][a-zA-Z\s,.'-]{1,39}|[\u4e00-\u9fa5]{2,12}?)(?:的)?(?:天气|气温|温度|预报|下雨|下雪)/gi
        ]
        for (const pattern of explicitPatterns) {
            for (const match of currentText.matchAll(pattern)) add(match[1])
        }

        const contextTexts = []
        if (memorySummary) contextTexts.push(String(memorySummary))
        for (const turn of recentHistory || []) {
            const text = (turn.parts || []).filter(p => p.text).map(p => p.text).join('\n')
            if (text) contextTexts.push(text)
        }

        const contextPatterns = [
            /(?:用户|主人|由依|我|本人)?(?:目前|现在|长期|常住|现居|居住|住|住在|位于|来自|所在地|所在城市|城市|地区|位置|定位|家在|人在)[^，。；;\n]{0,8}(?:是|为|在|:|：)?\s*([a-zA-Z][a-zA-Z\s,.'-]{1,39}|[\u4e00-\u9fa5]{2,16})/gi,
            /(?:常住地|现居地|所在地|所在城市|城市|地区|位置|定位)[：:是为\s]*([a-zA-Z][a-zA-Z\s,.'-]{1,39}|[\u4e00-\u9fa5]{2,16})/gi,
            /(?:在|住在|常住在|现居于|位于)([a-zA-Z][a-zA-Z\s,.'-]{1,39}|[\u4e00-\u9fa5]{2,16})(?:生活|工作|上学|居住|附近|这边|当地|本地)?/gi
        ]
        for (const text of contextTexts) {
            for (const pattern of contextPatterns) {
                for (const match of text.matchAll(pattern)) add(match[1])
            }
        }

        return hints.slice(0, 3)
    }

    /** 设置天气 API Key（由 AiClient 初始化时调用） */
    setWeatherApiKey(apiKey) {
        this.weatherApiKey = apiKey
    }

    /** 设置 OpenWeatherMap API Key */
    setOpenWeatherMapApiKey(apiKey) {
        this.openWeatherMapApiKey = apiKey
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

    /** 获取指定工具的 Function Calling schema */
    getFunctionSchemasFor(enabledTools = []) {
        const enabled = new Set(enabledTools)
        return [...this.tools.values()]
            .filter(t => enabled.has(t.name) && t.functionSchema)
            .map(t => t.functionSchema)
    }

    /** 获取指定工具的简短说明 */
    getToolSummaryLines(enabledTools = []) {
        const lines = []
        for (const name of enabledTools) {
            const tool = this.tools.get(name)
            if (!tool) continue
            const permNote = tool.permission === 'master' ? ' (仅主人)' : ''
            lines.push(`- ${tool.name}${permNote}: ${tool.description || ''}`)
        }
        return lines
    }

    /** 执行工具调用 */
    async execute(name, args, isMaster = false, context = {}) {
        const tool = this.tools.get(name)
        if (!tool) {
            logger.warn(`[AI-Plugin] 未知工具: ${name}`)
            return { success: false, error: `未知工具: ${name}` }
        }

        // 权限检查：permission 为 'master' 的工具仅主人可调用
        if (tool.permission === 'master' && !isMaster) {
            logger.warn(`[AI-Plugin] 工具 ${name} 权限不足：非主人尝试调用`)
            return { success: false, error: '权限不足：此工具仅限机器人主人使用' }
        }

        logger.info(`[AI-Plugin] 调用工具: ${name}, 参数: ${JSON.stringify(args)}`)
        try {
            const result = await tool.execute(args, { ...context, isMaster })
            const businessFailed = (result && typeof result === 'object' && result.ok === false)
                || (typeof result === 'string' && /^【[^】]+失败】/.test(result))
            if (businessFailed) {
                logger.warn(`[AI-Plugin] 工具 ${name} 业务失败: ${typeof result === 'string' ? result : JSON.stringify(result).slice(0, 300)}`)
            } else {
                logger.info(`[AI-Plugin] 工具 ${name} 执行成功`)
            }
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

    _parseJsonFromText(text) {
        const value = String(text || '').trim()
        if (!value) return null

        try {
            return JSON.parse(value)
        } catch { /* 尝试从回复中提取 JSON */ }

        const arrMatch = value.match(/\[[\s\S]*\]/)
        if (arrMatch) {
            try { return JSON.parse(arrMatch[0]) } catch { /* 继续尝试对象 */ }
        }

        const objMatch = value.match(/\{[\s\S]*\}/)
        if (objMatch) {
            try { return JSON.parse(objMatch[0]) } catch { /* ignore */ }
        }

        return null
    }

    _normalizeToolCalls(parsed, enabledTools = []) {
        if (!parsed) return []

        let tools = Array.isArray(parsed) ? parsed : []
        if (!tools.length && Array.isArray(parsed.tools)) tools = parsed.tools
        if (!tools.length && Array.isArray(parsed.calls)) tools = parsed.calls
        if (!tools.length && parsed && typeof parsed === 'object' && (parsed.tool || parsed.name)) {
            tools = [parsed]
        }

        return tools.map(t => {
            let args = t.args || t.params || t.parameters || t.arguments || {}
            if (typeof args === 'string') {
                try { args = JSON.parse(args) } catch { args = {} }
            }
            return {
                name: t.name || t.tool,
                args: args && typeof args === 'object' ? args : {}
            }
        }).filter(t => {
            if (!t.name || !enabledTools.includes(t.name)) {
                logger.warn(`[AI-Plugin] 工具编译 忽略非法工具: ${t.name}`)
                return false
            }
            return true
        })
    }

    /**
     * 工具计划编译：主模型负责理解上下文和制定计划，本方法只把计划转成可执行工具参数。
     * @param {object} mainPlan - 主模型输出的工具计划
     * @param {object} client - AiClient 实例
     * @param {string[]} enabledTools - 当前可用工具名
     * @param {object} options - 当前消息辅助信息
     * @returns {Promise<{intent: string, tools: Array<{name: string, args: object}>}>}
     */
    async compileToolPlan(mainPlan, client, enabledTools = [], options = {}) {
        if (!mainPlan || enabledTools.length === 0) return { intent: '', tools: [] }

        const plannedCalls = Array.isArray(mainPlan.tool_plan) ? mainPlan.tool_plan : []
        if (mainPlan.need_tools !== true || plannedCalls.length === 0) {
            return { intent: mainPlan.reason || '', tools: [] }
        }

        const now = new Date()
        const functionSchemas = this.getFunctionSchemasFor(enabledTools)
        const toolDescriptions = this.getToolSummaryLines(enabledTools)
        const candidateUrls = Array.isArray(options.candidateUrls) ? [...new Set(options.candidateUrls)].slice(0, 10) : []
        const mentionedUserIds = Array.isArray(options.mentionedUserIds) ? [...new Set(options.mentionedUserIds)].filter(Boolean) : []
        const hasImages = options.hasImages === true
        const hasRecentImages = options.hasRecentImages === true
        const maxTools = Math.max(1, Number(options.maxTools) || 5)
        const plannedToolNames = plannedCalls.map(call => call.tool || call.name).filter(Boolean)

        logger.info(`[AI-Plugin] 工具计划编译开始: 主模型计划=${plannedToolNames.join(', ') || '无'}, 可用工具=${enabledTools.join(', ')}, 有图片=${hasImages}, 有近期图片=${hasRecentImages}, @成员=${mentionedUserIds.join(', ') || '无'}`)

        const compilePrompt = `当前时间：${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日。
你是工具调用编译器，相当于主模型的协处理器。主模型已经读取完整上下文并决定了是否需要工具；你不要重新判断用户真实意图，只把主模型的工具计划编译成可执行 JSON。

可用工具：
${toolDescriptions.join('\n')}

工具 JSON Schema：
${JSON.stringify(functionSchemas, null, 2)}

当前用户原始消息：
${options.userMessage || ''}

当前消息是否包含图片：${hasImages ? '是' : '否'}；最近图片缓存是否可用：${hasRecentImages ? '是' : '否'}。注意：参考图、引用图、@头像、最近图片缓存由相关工具自己提取，你不要编造图片内容。

当前消息 @ 的成员：
${mentionedUserIds.length > 0 ? mentionedUserIds.map((id, index) => `${index + 1}. QQ：${id}`).join('\n') : '无'}

候选链接：
${candidateUrls.length > 0 ? candidateUrls.map((url, index) => `${index + 1}. ${url}`).join('\n') : '无'}

主模型工具计划：
${JSON.stringify(mainPlan, null, 2)}

编译规则：
- 只输出 JSON，不要输出解释、Markdown 或代码块。
- 输出格式必须是：{"intent":"一句话说明主模型计划","tools":[{"tool":"工具名","params":{...}}]}。
- 只能使用“可用工具”中列出的工具，最多输出 ${maxTools} 个工具调用，并保持主模型计划中的顺序。
- 不要新增主模型没有计划的工具；如果主模型计划含糊、参数不足且无法从原始消息/候选链接/计划中确定，返回 tools: []。
- 文件/目录路径可以保留主模型解析出的绝对路径、相对路径、别名或文件名片段，不要凭空发明路径。
- shell_exec 只能编译主模型明确计划的具体命令；不要为了补全信息自己设计危险命令。
- file_download 用于下载当前消息或引用消息里的媒体，不需要 URL；web_fetch 才需要完整 URL。
- draw_image 的参考图由工具自动提取（当前图、引用图、@头像、最近图片缓存）；角色参考图库参数按计划填写 character/characters/self_portrait。主模型已经计划 draw_image 时，不要仅因当前消息没有图片就丢弃调用；如果最近图片缓存可用，工具会按“刚才那张/这张图/用 p 模型处理/修图/去水印”等语义自行复用。
- group_chat_context 的 scope 必须按主模型计划保留：当前群前情用 current_group；用户问自己在别的群/其他群刚发了什么用 other_group_messages 并设置 exclude_current_group=true；用户问自己跨群最近消息但未排除当前群用 my_recent_messages；主人要求所有群或指定群才用 all_groups/specific_group。普通用户不要编译其他人的 user_id。
- 群管理成员操作必须有明确对象；有 QQ 号或 @ 时可填 user_id，没有 QQ 但有昵称/群名片时可填 target，拿不准唯一目标时先编译 group_member_list 或 group_member_resolve。
- 如果当前消息 @ 了唯一成员，且主模型计划的群管理操作目标是“这个人/被 @ 的人”，请直接把该 QQ 填入 user_id。
- group_request_handle 处理的是入群申请；用户说“刚才那个/他/那个人”且主模型计划处理待审申请时，可以省略 user_id；用户用昵称、QQ、留言关键词或含糊原话指代申请人时，把关键词写入 target。
- group_whole_mute 和 group_essence 的 enable、group_request_handle 的 approve 必须来自用户明确表达；不明确时不要编译这些高影响操作。`

        try {
            const payload = {
                contents: [
                    { role: "user", parts: [{ text: compilePrompt }] }
                ]
            }

            let result = null
            if (client.webSearchIntentModels.length > 0) {
                result = await client.quickIntentRequest(payload)
                if (!result?.success) {
                    logger.warn('[AI-Plugin] 工具计划编译专用模型失败，降级到 Flash 模型组')
                }
            }

            if (!result?.success) {
                result = await client.makeRequest('chat', payload, 'flash', 1024)
            }

            if (!result.success || !result.data) {
                logger.warn('[AI-Plugin] 工具计划编译 LLM 调用失败')
                return { intent: mainPlan.reason || '', tools: [] }
            }

            const analysisText = String(result.data || '').trim()
            const modelInfo = result.platform ? ` [${result.platform}]` : ''
            logger.info(`[AI-Plugin] 工具计划编译${modelInfo} 返回: "${analysisText.slice(0, 300)}"`)

            const parsed = this._parseJsonFromText(analysisText)
            if (!parsed) {
                logger.warn('[AI-Plugin] 工具计划编译 JSON 解析失败')
                return { intent: mainPlan.reason || '', tools: [] }
            }

            let validCalls = this._normalizeToolCalls(parsed, enabledTools).slice(0, maxTools)

            if (hasImages && !this._hasExplicitWebSearchIntent(options.userMessage || '')) {
                const before = validCalls.length
                validCalls = validCalls.filter(t => t.name !== 'web_search')
                if (before !== validCalls.length) {
                    logger.info('[AI-Plugin] 带图消息缺少明确搜索意图，工具编译已过滤 web_search')
                }
            }

            const intent = parsed.intent || mainPlan.resolved_request || mainPlan.reason || ''
            logger.info(`[AI-Plugin] 工具计划编译决定调用 ${validCalls.length} 个工具: ${validCalls.map(t => t.name).join(', ')}`)
            return { intent, tools: validCalls }
        } catch (err) {
            logger.warn('[AI-Plugin] 工具计划编译失败:', err)
            return { intent: mainPlan.reason || '', tools: [] }
        }
    }

    /**
     * LLM 工具路由：统一分析用户消息，决定需要调用哪些工具
     * 替代原有的关键词匹配意图检测，用 deepseek-v4-flash 做智能路由
     * @param {string} userMessage - 用户消息文本
     * @param {object} client - AiClient 实例
     * @param {string[]} enabledTools - 当前可用的工具名列表
     * @returns {Promise<{intent: string, tools: Array<{name: string, args: object}>}>} 意图和工具调用列表
     */
    async analyzeToolIntent(userMessage, client, enabledTools = [], recentHistory = [], memorySummary = '', candidateUrls = [], options = {}) {
        if (!userMessage || !userMessage.trim() || enabledTools.length === 0) return { intent: '', tools: [] }

        const now = new Date()
        const hasImages = options.hasImages === true
        const hasRecentImages = options.hasRecentImages === true

        // 构建工具描述
        const toolDescriptions = []
        for (const name of enabledTools) {
            const tool = this.tools.get(name)
            if (!tool) continue
            const permNote = tool.permission === 'master' ? ' (仅主人)' : ''
            toolDescriptions.push(`- ${tool.name}${permNote}: ${tool.description || ''}`)
        }

        // 构建最近对话上下文（只提取文本，忽略图片）
        let contextBlock = ''
        if (recentHistory.length > 0) {
            const contextLines = []
            for (const turn of recentHistory) {
                const role = turn.role === 'model' ? 'AI' : '用户'
                const texts = (turn.parts || [])
                    .filter(p => p.text)
                    .map(p => p.text.slice(0, 400))  // 每段最多400字，控制token
                if (texts.length > 0) {
                    contextLines.push(`${role}: ${texts.join(' ')}`)
                }
            }
            if (contextLines.length > 0) {
                contextBlock = `\n\n最近对话上下文（帮助你理解用户当前意图，注意指代关系）：\n${contextLines.join('\n')}\n`
            }
        }

        // 构建记忆总结上下文（增量总结，截取前2600字；天气等工具需要长期地点线索）
        let summaryBlock = ''
        if (memorySummary) {
            const trimmed = memorySummary.slice(0, 2600)
            summaryBlock = `\n\n用户与AI的历史记忆摘要（帮助理解长期上下文，如提到过的话题、偏好、路径等）：\n${trimmed}\n`
        }

        const weatherCityHints = enabledTools.includes('weather') && this._isWeatherRequest(userMessage)
            ? this._extractWeatherCityHints(userMessage, memorySummary, recentHistory)
            : []
        const weatherHintBlock = weatherCityHints.length > 0
            ? `\n\n【天气地点上下文候选】如果用户询问天气但当前消息没有明确城市，可以优先使用这些从当前消息/长期记忆/最近上下文中抽取到的地点：${weatherCityHints.join('、')}。如果用户明确说了其他城市，以用户当前消息为准。\n`
            : ''

        // 构建候选链接上下文（来自当前消息、引用消息、合并转发及嵌套合并转发）
        let candidateUrlBlock = ''
        if (Array.isArray(candidateUrls) && candidateUrls.length > 0) {
            const urls = [...new Set(candidateUrls)].slice(0, 10)
            candidateUrlBlock = `\n\n当前消息/引用/合并转发中发现的候选链接（仅当用户明确需要查看、总结、分析网页内容时才调用 web_fetch）：\n${urls.map((url, index) => `${index + 1}. ${url}`).join('\n')}\n`
        }

        // 当前消息图片上下文：意图分析模型只接收文本，不看图；带图时避免从短文本脑补工具需求
        const imageContextBlock = hasImages
            ? '\n\n当前用户消息包含图片。注意：你看不到图片内容，图片理解会交给后续多模态主模型处理。若文字本身没有明确要求搜索、查天气、读文件、执行命令或抓取链接，不要仅凭短语/表情/图片上下文脑补工具调用，tools 应返回空数组。\n'
            : (hasRecentImages ? '\n\n当前用户消息没有新图片，但最近图片缓存可用。若用户明确说“刚才那张/这张图/用 p 模型处理/修图/去水印/套预设”等，draw_image 可以复用最近图片；普通聊天不要因此调用工具。\n' : '')

        // 角色参考图库说明：角色外貌设定统一放在 data/characters/{角色ID}/profile.yaml
        const characterLibraryBlock = enabledTools.includes('draw_image')
            ? '\n\n【角色参考图库说明】draw_image 支持 character 参数和 characters 数组。用户要求"画你自己/画 AI 本人/看看你长什么样"等时，可设置 self_portrait=true 或 character="noa"；prompt 只填用户额外提出的动作、场景、风格要求。用户要求画单个已配置角色（如诺亚/优香/真纪/莉音/其他角色名或别名）时，把 character 填为用户说的角色名或别名；用户要求同一画面出现多个已配置角色时，把 characters 填为角色名/别名数组（如 ["noa", "yuuka"]），并把场景、动作、镜头、风格写入 prompt。角色外貌设定由 data/characters/{角色ID}/profile.yaml 提供，每个角色会各取一张参考图。\n'
            : ''

        const analysisPrompt = `当前时间：${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日。你是一个意图分析助手。分析用户消息，输出意图分析和需要调用的工具。

可用工具：
${toolDescriptions.join('\n')}

各工具参数格式：
- web_search: {"query": "搜索关键词"}
- system_info: {}
- weather: {"city": "城市名"}
  - 天气工具参数要求：如果用户查询的是国外城市，或使用中文外文地名（如纽约、伦敦、巴黎、东京、洛杉矶），请尽量转换为 OpenWeatherMap 可识别的英文城市名（如 New York、London、Paris、Tokyo、Los Angeles）后填入 city。
  - 如果当前天气请求没有写城市，但历史记忆摘要或最近上下文明确给出了用户常住地/所在地/所在城市，可使用该地点查询；没有明确地点时再返回空工具并追问城市。
- file_read: {"path": "文件/目录路径或别名", "read_all": true或false}
- dir_read: {"path": "目录路径或别名", "read_all": true或false}
- shell_exec: {"command": "要执行的shell命令", "cwd": "可选工作目录", "timeout_ms": 可选超时毫秒, "max_output_chars": 可选最大输出字符数}
  - Shell 工具参数要求：仅当用户明确要求查看/搜索/诊断/操作服务器，且普通 file_read/dir_read 不足以完成时使用。
  - Shell 拥有完整服务器命令权限。可以使用 grep/rg/find/ls/cat/git/systemctl/docker 等命令；命令必须具体、可执行，不要编造不存在的路径。
  - 用户说“在 AI-Plugin/ai-plugin/插件目录执行 git pull/status/log”等时，command 填用户要求的 git 命令，cwd 填 "plugins/AI-Plugin"。
  - 优先选择只读/查询命令完成排查；只有用户明确要求修改、删除、安装、重启等操作时，才生成有副作用的命令。
  - 如果用户意图需要连续多步操作，可以一次返回多个 shell_exec 调用，但不要返回无限运行或交互式命令。
  - 文件工具参数要求：用户给出绝对路径时直接使用；用户说“日志/配置/模型配置/插件目录/云崽data/data目录”等常用说法时，可直接把这些自然语言关键词填入 path，工具会在白名单内解析。
  - 用户给出相对路径、文件名片段，或说“上次那个文件/那个目录”时，也可以填入对应片段或原话，工具会结合最近成功路径与白名单目录尝试定位。
  - 如果完全无法判断目标文件/目录，不要编造路径，tools 返回空数组，并在 intent 中说明需要向用户追问目标范围。
- web_fetch: {"url": "完整URL"}
  - 网页抓取要求：当用户明确要求查看、总结、解释、分析链接内容时，可以优先使用候选链接中的 URL 调用 web_fetch。
  - 如果消息或引用/转发里只是出现链接，但用户没有阅读网页内容的需求，不要仅因为有链接就调用 web_fetch。
- file_send: {"path": "要发送的文件/文件夹路径或文件名片段", "as_image": "可选 true/false"}
  - 文件发送要求：当用户要求把服务器上的某个文件/文件夹"发给我/发到群里/发出来"时使用。path 可填用户说的文件名、片段或别名，工具会在白名单内查找并发送（文件夹自动打包）。
  - as_image：仅当用户明确说"以图片形式/作为图片/直接发图/发成图片"发送服务器上的图片文件时设为 true；否则不要填或设为 false，按普通文件发送。
  - 若用户只是模糊描述（如"把那个日志发我"），可先用 dir_read/file_read 确认目标，再用 file_send 发送确认到的文件。
- file_download: {"save_dir": "可选，保存目录", "force_ext": "可选，统一后缀如.png"}
  - 文件下载要求：当用户要求把当前消息或其引用消息里的图片/视频/语音/文件"下载/保存到服务器"时使用。无需填 URL，工具会自动从消息中提取媒体。
  - 文件名固定按顺序命名为 0、1、2、3…，后缀默认保持每个文件原本的类型，这是默认行为，无需任何参数。
  - save_dir：用户明确说了要存到哪个目录（如"存到/root/xxx""下载到resources/tmp"）才填，文件会直接存进该目录；用户没指定目录时就留空，工具会自动存到默认位置 resources/noa/时间戳 子目录。
  - force_ext：仅当用户特别要求"全部存成gif/统一改成png/都保存为xxx格式"时才填该后缀（如".gif"），否则一律留空保持原后缀。
- group_file_list: {"folder_name": "可选，子文件夹名", "recursive": 可选true/false}
  - 群文件浏览要求：当用户想"看看群文件有哪些/列一下群文件/群文件里有什么"时使用。要进某个子文件夹就填 folder_name，否则留空看根目录。当用户想"连文件夹里的文件也一起看/全部列出来/包括子文件夹"时把 recursive 设为 true。注意这是 QQ"群文件区"，不是聊天消息里的文件。
- group_file_download: {"file_name": "可选，群文件名", "save_dir": "可选，保存目录"}
  - 群文件下载要求：当用户要求把"群文件里的某个文件"下载/保存到服务器某目录时使用。file_name 填用户说的文件名（可为片段）。若用户是"引用了一条群文件消息"再说"下载这个/帮我下载到xxx/把这个存到服务器"，或者说"把刚才那个群文件/上次引用的文件下载到xxx"，file_name 都可以留空——工具会自动从被引用的群文件消息提取，或回退到最近引用过的群文件名。这是从 QQ 群文件区下载，区别于 file_download（后者下载聊天消息里的媒体）。
- group_chat_context: {"scope": "current_group/my_recent_messages/other_group_messages/all_groups/specific_group", "limit": "可选，读取最近多少条群消息", "query": "可选，关键词", "group_id": "可选群号", "user_id": "可选用户QQ", "exclude_current_group": "可选true/false"}
  - 群聊上下文要求：用户问"刚才/之前/他们/大家/群里聊了什么、发生了什么、前情提要、总结最近群聊"时使用。
  - 默认 scope=current_group，只查当前群。
  - 用户问"我刚在别的群/其他群发了什么""你看到我在别的群的消息吗"时，用 scope=other_group_messages 或 scope=my_recent_messages，并设置 exclude_current_group=true；普通用户只能查自己的跨群消息，不要填其他人的 user_id。
  - 主人明确要求跨群/所有群/某个群的已捕获流水时，可用 scope=all_groups 或 specific_group，并可填 group_id/user_id/query。
  - query 只在用户问特定话题、昵称、QQ 或关键词时填写。
- group_member_aliases: {"target_user_id": "可选，成员QQ", "query": "可选，外号/称呼/QQ/来源昵称关键词", "limit": "可选数量"}
  - 群成员称呼记忆要求：用户问"这个人是谁""@某某有什么外号/称呼""杂鱼是谁""谁被叫过xxx"等本群称呼、外号、调侃称呼时使用。用户 @ 了成员或给出 QQ 时填 target_user_id；只给外号/关键词时填 query。查询结果只表示本群公开聊天里有人这样称呼过，不代表真实身份或事实断言。
- draw_image: {"prompt": "画图描述", "preset": "可选预设名", "quality": "可选 flash/pro/ultra", "self_portrait": "可选 true/false", "character": "可选单个角色ID或别名", "characters": "可选多个角色ID或别名数组"}
  - 画图要求：当用户明确要求"画/绘制/生成一张图/帮我画/做张图/用某某风格画"等时使用。prompt 填用户想画的内容描述。
  - 用户提到具体已有风格名（如"手办化""手办风"）时填 preset；不确定是否为预设就不要填 preset，直接用 prompt 描述。
  - 参考图（用户带图、引用的图、@的成员头像、最近图片缓存）由工具自动从消息中提取，不需要你处理图片，也不要因为有图就改用其他工具。
  - 用户明确要求对当前/最近图片进行修图、重绘、去水印、去二维码、套风格或"用 p/pro 模型处理"时可以调用；但不要承诺精准像素级编辑。
  - 只有用户确实想要生成/创作图片时才调用；普通聊天、发图让你看图说话、问问题都不要调用 draw_image。
  - 角色参考图库：当用户要求画单个角色（如诺亚/优香/真纪/莉音，或用户提到的其他明确角色名）时，把 character 填为用户说的角色名或别名；当用户要求同一张图里出现多个角色时，把 characters 填为角色名/别名数组（如 ["noa", "yuuka"]）。prompt 只填用户额外提出的动作、场景、镜头、风格要求。工具会自动从 data/characters/{角色ID}/profile.yaml 和图片加载参考，每个角色各取一张参考图。
  - 特别注意：当用户要求"画你自己/画一下你/画 AI 本人/给我看看你长什么样"等指向 AI 自身形象时，把 self_portrait 设为 true（等价于 character="noa"），prompt 只需填用户额外提出的动作/场景/风格（如"在海边""穿和服"），没有额外要求时 prompt 可留空。
- group_mute: {"user_id": "QQ号", "time": 时长数值, "unit": "秒/分钟/小时/天"}
  - 禁言/解禁要求：用户要"禁言某人/把xxx禁言N分钟/闭嘴/解除xxx的禁言"时使用。被操作者的 QQ 号从 @ 或消息中获取。解除禁言时 time 填 0。
- group_whole_mute: {"enable": true/false}
  - 全员禁言要求：用户要"开启/解除全员禁言、全体禁言"时使用。enable=true 开启，false 解除。
- group_kick: {"user_id": "QQ号", "block": true/false}
  - 踢人要求：用户要"把xxx踢了/踢出群/移出群聊"时使用。要求"拉黑/不再让进"时 block=true。
- group_set_card: {"user_id": "QQ号", "card": "新名片"}
  - 改名片要求：用户要"把xxx的群名片/群昵称改成yyy"时使用。card 留空表示清除名片。
- group_set_title: {"user_id": "QQ号", "title": "头衔"}
  - 设头衔要求：用户要"给xxx一个专属头衔yyy/取消头衔"时使用。title 留空表示清除。
- group_essence: {"enable": true/false}
  - 精华消息要求：用户「引用某条消息」并说"设为精华/加精/取消精华"时使用。enable=true 加精，false 取消。
- group_member_list: {"query": "可选，昵称/群名片/QQ号", "limit": 可选数量}
  - 群成员查询要求：用户问"群里有哪些成员/查看群成员/找昵称xxx的人"时使用。query 留空列出成员列表；有目标词时填 query 搜索。
- group_member_resolve: {"target": "可选，昵称/群名片/QQ号/用户原话"}
  - 群成员解析要求：当用户想对某个成员做群管理，但只给了昵称、群名片或 @ 对象，且需要先确认具体 QQ 号时使用。用户已经 @ 成员时 target 可留空。
- group_request_list: {}
  - 查看入群申请要求：用户问"有没有人申请进群/看看入群申请/谁要进群"时使用。
- group_request_handle: {"user_id": "QQ号，可选", "target": "昵称/QQ/留言关键词/用户原话，可选", "approve": true/false, "reason": "可选拒绝理由"}
  - 处理入群申请要求：用户要"通过/同意/拒绝某人的加群申请"时使用。approve=true 通过，false 拒绝；用户说"刚才那个/他/那个人"且没有 QQ 号时可以省略 user_id，由工具在当前群只有一条待审申请时自动定位；多条申请时可填 target 做昵称/留言模糊匹配，例如"幸福的"。
  - 注意：group_chat_context 和 group_member_aliases 是只读上下文工具；group_mute/group_whole_mute/group_kick/group_set_card/group_set_title/group_essence/group_member_list/group_member_resolve/group_request_list/group_request_handle 属于群管理相关工具，仅在权限允许时可用。对禁言/踢人/改名片/设头衔等成员操作，优先使用真实 QQ 号或 @；如果只有昵称/群名片且不确定唯一目标，先调用 group_member_list 或 group_member_resolve，不要凭空编造 user_id。

请严格按以下JSON格式输出，不要输出其他任何内容：
{"intent": "用户意图分析（一句话概括用户想做什么、隐含需求等）", "tools": [{"tool": "工具名", "params": {...}}]}

规则：
- 如果用户消息不需要任何工具，tools 返回空数组 []
- intent 字段必填，简要分析用户意图
- 只使用上述"可用工具"列表中列出的工具，不要调用未列出的工具
- 文件/目录工具不强制要求用户提供绝对路径；可使用用户原话中的路径、别名、相对路径或文件名片段，由工具在白名单内解析
- 搜索关键词要求精确、简洁，不超过128字`

        try {
            const analysisPayload = {
                contents: [
                    { role: "user", parts: [{ text: analysisPrompt + imageContextBlock + characterLibraryBlock + summaryBlock + weatherHintBlock + contextBlock + candidateUrlBlock + `\n\n用户消息：\n${userMessage}` }] }
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
                result = await client.makeRequest('chat', analysisPayload, 'flash', 1024)
            }

            if (!result.success || !result.data) {
                logger.warn('[AI-Plugin] 工具路由 LLM 调用失败')
                return { intent: '', tools: [] }
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
                return { intent: '', tools: [] }
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
            let intent = parsed.intent || ''

            // 过滤非法工具调用
            let validCalls = tools.filter(t => {
                if (!t.name || !enabledTools.includes(t.name)) {
                    logger.warn(`[AI-Plugin] 工具路由 忽略非法工具: ${t.name}`)
                    return false
                }
                return true
            })

            if (enabledTools.includes('weather') && this._isWeatherRequest(userMessage)) {
                const firstHint = weatherCityHints[0]
                let filledWeather = false
                validCalls = validCalls.map(call => {
                    if (call.name !== 'weather') return call
                    const city = call.args?.city || call.args?.query || ''
                    if (city || !firstHint) return call
                    filledWeather = true
                    return { ...call, args: { ...call.args, city: firstHint } }
                })
                if (validCalls.length === 0 && firstHint) {
                    validCalls = [{ name: 'weather', args: { city: firstHint } }]
                    intent = `规则兜底：用户询问天气，当前消息未提供城市，但上下文地点候选为「${firstHint}」，直接查询该城市天气。`
                    logger.info(`[AI-Plugin] 天气工具路由兜底命中上下文城市: ${firstHint}`)
                } else if (filledWeather) {
                    logger.info(`[AI-Plugin] 天气工具参数已用上下文城市补全: ${firstHint}`)
                }
            }

            // 带图消息的意图分析模型看不到图片，短文本容易脑补搜索；没有明确搜索/查询意图时禁止自动搜索
            if (hasImages && !this._hasExplicitWebSearchIntent(userMessage)) {
                const before = validCalls.length
                validCalls = validCalls.filter(t => t.name !== 'web_search')
                if (before !== validCalls.length) {
                    logger.info('[AI-Plugin] 带图消息缺少明确搜索意图，已过滤 web_search，交给多模态主模型处理')
                }
            }

            logger.info(`[AI-Plugin] 工具路由 决定调用 ${validCalls.length} 个工具: ${validCalls.map(t => t.name).join(', ')}`)
            return { intent, tools: validCalls }
        } catch (err) {
            logger.warn('[AI-Plugin] 工具路由 失败:', err)
            return { intent: '', tools: [] }
        }
    }
}

export const toolRegistry = new ToolRegistry()
