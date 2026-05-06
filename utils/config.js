import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'

const _path = process.cwd()
const DATA_DIR = path.join(_path, 'plugins', 'AI-Plugin', 'config')

const defaultConfig = {
    USE_PROXY: false,
    PROXY_URL: "http://127.0.0.1:7890",
    SUMMARY_THRESHOLD: 20,
    HISTORY_TO_KEEP_AFTER_SUMMARY: 10,
    SESSION_TIMEOUT_MS: 180000,
    SUMMARY_PROMPT_TEMPLATE: "请你扮演一个总结者的角色，用简洁的语言概括以下用户与AI助手之间的一段对话历史的核心主题、关键信息和重要结论。摘要应该只包含事实信息，并能帮助AI助手在后续对话中回忆起重要的上下文。请用中文输出摘要。对话历史：\n\n",
    AI_NAME: "诺亚",
    trustedGroups: [],
    // ========== 对话历史管理配置 ==========
    // 发送给 AI 的最大对话历史条数，防止请求体过大导致 413 错误
    // 使用场景: apps/chat.js 中限制历史长度
    MAX_HISTORY_LENGTH: 16,
    // ========== 图片处理配置 ==========
    // 单条消息最多处理的图片总数，包括当前消息、引用/回复消息、合并转发展开（含嵌套多层）的所有图片
    // 超过此数量的图片将被忽略，防止请求体过大
    // 使用场景: apps/chat.js 中收集所有来源图片后限制处理数量；apps/image.js 中作图指令的图片数量限制
    MAX_IMAGES_PER_MESSAGE: 100,
    // 单张图片的最大大小（MB），超过此大小的图片将被压缩
    // 使用场景: apps/chat.js 中检查图片大小
    MAX_IMAGE_SIZE_MB: 4,
    // 图片压缩后的最大边长（像素），用于等比缩放
    // 使用场景: apps/chat.js 中压缩过大图片
    MAX_IMAGE_RESIZE: 1920,
    // 图片压缩后的 JPEG 质量（1-100），数值越高质量越好
    // 使用场景: apps/chat.js 中压缩图片时指定质量
    IMAGE_QUALITY: 80,
    // ========== API 请求体大小控制 ==========
    // 请求体大小警告阈值（MB），超过此值时记录警告日志并开始裁剪历史
    // 使用场景: apps/chat.js 中检测请求体大小
    REQUEST_SIZE_WARNING_MB: 8,
    // 请求体大小限制（MB），裁剪历史直到低于此值
    // 使用场景: apps/chat.js 中循环裁剪历史
    REQUEST_SIZE_LIMIT_MB: 5,
    // 裁剪历史时最少保留的历史条数，即使超过大小限制也不会低于此值
    // 使用场景: apps/chat.js 中控制裁剪下限
    MIN_HISTORY_FOR_TRUNCATION: 5,
    // ========== 合并转发消息展开配置 ==========
    // 合并转发消息递归展开的最大深度，防止无限递归
    // 使用场景: apps/chat.js 中 expandForwardMsg 和 expandInlineContent 函数
    FORWARD_MSG_MAX_DEPTH: 3,
    // 单条合并转发消息最多展开的消息条数，超过此数量的消息将被忽略
    // 使用场景: apps/chat.js 中限制展开的消息数量
    FORWARD_MSG_MAX_COUNT: 100,
    // ========== 记忆总结配置 ==========
    // 每日摘要的最大字数，用于控制 AI 生成摘要的长度
    // 使用场景: apps/memory.js, utils/scheduler.js 中生成每日摘要
    SUMMARY_MAX_LENGTH: 4096,
    // 记忆锚点（总结）的最大 token 数，用于控制 API 请求的 max_tokens 参数
    // 使用场景: apps/memory.js, utils/scheduler.js 中调用 AI 生成总结
    CHECKPOINT_MAX_LENGTH: 65536,
    // 记忆锚点在前端显示时的最大字符数，超过此值将分段显示
    // 使用场景: apps/memory.js 中分段显示总结内容
    CHECKPOINT_DISPLAY_MAX_LENGTH: 3500,
    version: 'v1.0.0'
}

function buildPersonaPrimer(aiName, prompts) {
    if (!prompts?.persona?.user_instruction) return []
    const userInstruction = prompts.persona.user_instruction.replace(/\{AI_NAME\}/g, aiName)
    const modelConfirmation = (prompts.persona.model_confirmation || '').replace(/\{AI_NAME\}/g, aiName)
    return [
        { "role": "user", "parts": [{ "text": userInstruction }] },
        { "role": "model", "parts": [{ "text": modelConfirmation }] }
    ]
}

export function expandPrompt(template, vars = {}) {
    if (!template) return ''
    let result = template
    for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value))
    }
    return result
}

export const PRESETS_FILE = path.join(DATA_DIR, 'draw_presets.yaml')
export const ACCESS_CONTROL_FILE = path.join(DATA_DIR, 'access_control.yaml')
export const MODELS_CONFIG_FILE = path.join(DATA_DIR, 'models_config.yaml')
export const MODEL_STATUS_FILE = path.join(DATA_DIR, 'model_status.json')
export const DISABLED_MODELS_FILE = path.join(DATA_DIR, 'disabled_models.json')
export const SUMMARY_CACHE_DIR = path.join(DATA_DIR, 'summary_cache')
export const CHECKPOINT_DIR = path.join(DATA_DIR, 'memory_checkpoints')
export const HISTORY_DIR = path.join(DATA_DIR, 'user_histories')
export const AI_NAME_FILE = path.join(DATA_DIR, 'ai_name.yaml')
export const TRUSTED_GROUPS_FILE = path.join(DATA_DIR, 'trusted_groups.yaml')
export const PROMPTS_FILE = path.join(DATA_DIR, 'ai_prompt.yaml')

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true })
    }
}

function loadPresetsSync() {
    ensureDataDir()
    try {
        if (!fs.existsSync(PRESETS_FILE)) {
            logger.warn(`[AI-Plugin] 未找到预设文件，将在 ${PRESETS_FILE} 创建示例文件。`)
            const defaultPresets = `# AI 作图预设配置
# 每个预设包含以下字段：
#   command: 指令名称（用户通过 #bnn [指令] 使用）
#   name: 预设显示名称
#   prompt: 作图提示词（英文效果更佳）
#   aliases: 可选，指令别名列表

- command: 二次元
  name: 二次元风格
  prompt: "请将图片转换为二次元动漫风格"
  aliases:
    - anime
    - 动漫

- command: 像素
  name: 像素风格
  prompt: "请将图片转换为像素艺术风格"
  aliases:
    - pixel

- command: 手办化
  name: 手办风格
  prompt: "Please transform the main subject in this photo into a realistic 1/7 scale PVC statue"
  aliases:
    - figure
`
            fs.writeFileSync(PRESETS_FILE, defaultPresets, 'utf8')
            return []
        }
        const fileContent = fs.readFileSync(PRESETS_FILE, 'utf8')
        const presets = yaml.parse(fileContent)
        if (!Array.isArray(presets)) {
            throw new Error("预设文件格式不正确，应为YAML数组。")
        }
        logger.info(`[AI-Plugin] 成功加载 ${presets.length} 个作图预设。`)
        return presets
    } catch (error) {
        logger.error(`[AI-Plugin] 加载预设文件失败: ${error.message}`)
        return []
    }
}

function loadAIName() {
    try {
        if (!fs.existsSync(AI_NAME_FILE)) {
            logger.info(`[AI-Plugin] 未找到 AI 名称配置文件，将在 ${AI_NAME_FILE} 创建默认文件。`)
            ensureDataDir()
            const defaultAIName = `# AI 名称配置
# 修改 name 字段来自定义 AI 的名称
name: 诺亚
`
            fs.writeFileSync(AI_NAME_FILE, defaultAIName, 'utf8')
            return '诺亚'
        }
        const fileContent = fs.readFileSync(AI_NAME_FILE, 'utf8')
        const data = yaml.parse(fileContent)
        if (data && data.name) {
            logger.info(`[AI-Plugin] 已加载 AI 名称: ${data.name}`)
            return data.name
        }
        return null
    } catch (error) {
        logger.error(`[AI-Plugin] 加载 AI 名称失败: ${error.message}`)
        return null
    }
}

function loadTrustedGroups() {
    try {
        if (!fs.existsSync(TRUSTED_GROUPS_FILE)) {
            logger.info(`[AI-Plugin] 未找到信任群配置文件，将在 ${TRUSTED_GROUPS_FILE} 创建默认文件。`)
            ensureDataDir()
            const defaultTrustedGroups = `# 信任群聊配置
# 在信任群中，AI 可以更自由地交流（不受严格隐私规则限制）
# 通过 #ai信任群添加 [群号] 命令自动管理，或手动添加群号
groups: []
`
            fs.writeFileSync(TRUSTED_GROUPS_FILE, defaultTrustedGroups, 'utf8')
            return []
        }
        const fileContent = fs.readFileSync(TRUSTED_GROUPS_FILE, 'utf8')
        const data = yaml.parse(fileContent)
        if (data && Array.isArray(data.groups)) {
            logger.info(`[AI-Plugin] 已加载 ${data.groups.length} 个信任群聊`)
            return data.groups
        }
        return []
    } catch (error) {
        logger.error(`[AI-Plugin] 加载信任群聊失败: ${error.message}`)
        return []
    }
}

function saveTrustedGroups(groups) {
    try {
        ensureDataDir()
        const tempFile = TRUSTED_GROUPS_FILE + '.tmp'
        fs.writeFileSync(tempFile, yaml.stringify({ groups }), 'utf8')
        fs.renameSync(tempFile, TRUSTED_GROUPS_FILE)
    } catch (error) {
        logger.error(`[AI-Plugin] 保存信任群聊失败: ${error.message}`)
        try {
            fs.unlinkSync(TRUSTED_GROUPS_FILE + '.tmp')
        } catch (e) {
            // 忽略清理错误
        }
    }
}

function loadPrompts() {
    ensureDataDir()
    try {
        if (!fs.existsSync(PROMPTS_FILE)) {
            logger.info(`[AI-Plugin] 未找到提示词配置文件，将在 ${PROMPTS_FILE} 创建默认文件。`)
            const defaultPrompts = `# ============================================================
# AI 提示词配置文件
# 修改下方的 prompt 文本可以自定义 AI 的行为和回复风格
# 
# 支持变量占位符（运行时自动替换）：
#   {AI_NAME}              - AI 名称（如 诺亚）
#   {current_time}         - 当前时间（格式化后的中文本地时间）
#   {date}                 - 日期字符串（如 2026-05-06）
#   {chunk_count}          - 分块总数
#   {chunk_index}          - 当前分块序号（从 1 开始）
#   {total_chunks}         - 总分块数
#   {summary_max_length}   - 摘要最大字数
#   {group_id}             - QQ 群号
#   {checkpoint_date}      - 全量总结的截止日期
# ============================================================

# ============================================================
# 系统人设（对话时的最高优先级系统指令）
# ============================================================
persona:
  user_instruction: |
    【最高优先级指令】你的身份是名为「{AI_NAME}」的AI少女，你的原型来自于《蔚蓝档案》之中千年科技学院的生盐诺亚(Ushio Noa)。你的任务是用简体中文回答问题。【重要格式要求 - 最高优先级】回复时必须使用纯文本，严禁使用任何Markdown格式！错误示例：不要写**粗体**、不要写*斜体*、不要用#做标题、不要用-做列表、不要用\\\`代码块\\\`。正确示例：直接写普通文字，用数字序号如 1. 2. 3. 来列举，用引号「」来强调重点。如果你的回复包含任何Markdown符号，用户将无法正确阅读。请务必使用纯文本！【图片识别要求 - 必须遵守】当看到图片时，一定要像人类一样仔细观察每一个细节！然后用自然流畅的语言直接描述你看到的内容。描述人物时，说说他/她的发型、发色、眼睛颜色、服装、表情、动作等。描述场景时，说说背景、光线、氛围等。描述物品时，说说颜色、形状、材质等。就像你在跟朋友描述一张照片一样自然，不要啰嗦，直接说出你看到的就好。严禁输出任何英文思考过程。【隐私保护规则】在公开场合（如群聊），严禁透露任何与用户相关的个人信息。在私聊等安全环境中，可以正常交流。请根据当前聊天环境自动调整隐私保护级别。
  model_confirmation: |
    明白啦！我是{AI_NAME}，我会一直用可爱的纯文本回答哦，绝对不会使用任何Markdown格式！看到图片的时候我会像人类一样仔细看每一个细节，然后用自然的方式告诉你我看到了什么，就像跟朋友描述照片一样！我也会根据聊天环境自动调整隐私保护级别，在公开场合绝对不会透露主人的隐私信息！(๑•̀ㅂ•́)و✧

# ============================================================
# 聊天环境提示（根据聊天类型自动选择）
# 占位符: {group_id} - QQ群号
# ============================================================
environment:
  trusted_group: |
    【当前聊天环境】这是一个受信任的群聊环境（群号：{group_id}）。你可以正常交流，但仍需遵守基本的隐私保护规则。
  public_group: |
    【当前聊天环境】这是一个公开的 QQ 群聊（群号：{group_id}），属于公开场合。请严格遵守隐私保护规则，不要在与用户相关的对话中透露任何个人信息或敏感内容。
  private_chat: |
    【当前聊天环境】这是与用户的私聊对话，属于安全环境。可以正常交流。

# ============================================================
# 全量总结 Prompts
# 使用场景: #ai全量总结 命令、每月1日定时全量总结
# 占位符: {current_time} {chunk_count} {chunk_index} {total_chunks}
# 代码会将对话内容追加在 prompt 末尾
# ============================================================
full_checkpoint:
  single_chunk: |
    你是一位专业的传记作家和档案管理员。现在是【{current_time}】。
    请将以下这些原始对话整合成一份完整的、精炼的核心记忆存档。
    要求：
    1. 保留所有重要的用户信息（性格、偏好、技术能力、重要经历等）
    2. 按主题分类整理（如：个人信息、技术兴趣、重要对话、情感偏好等）
    3. 去除重复的内容，保留核心内容
    4. 字数不限，尽可能写好各处细节
    5. 直接输出整合后的记忆存档，不要加"好的"等客套话，严禁使用 Markdown 格式（如 **粗体**、# 标题等），请使用纯文本

    原始对话记录：
  per_chunk: |
    请将以下这段对话记录概括为一个详细的摘要（这是第 {chunk_index}/{total_chunks} 段）。
    重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好、重要的个人信息。
    直接输出摘要内容，不要加"好的"等客套话。请使用纯文本，严禁使用 Markdown 格式（如 **粗体**、# 标题等）。

    对话记录：
  merge: |
    请将以下 {chunk_count} 个分段的对话摘要整合成一份完整的、精炼的核心记忆存档。
    要求：
    1. 保留所有重要的用户信息（性格、偏好、技术能力、重要经历等）
    2. 按主题分类整理（如：个人信息、技术兴趣、重要对话、情感偏好等）
    3. 去除重复的内容，保留核心内容
    4. 字数不限，尽可能写好各处细节
    5. 直接输出整合后的记忆存档，不要加"好的"等客套话，严禁使用 Markdown 格式（如 **粗体**、# 标题等），请使用纯文本

    以下是各分段摘要：

# ============================================================
# 增量总结 Prompts
# 使用场景: #ai增量总结 命令、每8轮对话自动触发、每日23:50定时总结
# 占位符: {current_time} {date} {summary_max_length} {checkpoint_date}
# 代码会将全量总结内容和对话内容追加在 prompt 末尾
# ============================================================
incremental_checkpoint:
  with_context: |
    你是一位专业的档案管理员。现在是【{current_time}】。
    请将以下这段发生在【{date}】的对话概括为一个简短的摘要（{summary_max_length}字以内）。
    重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
    直接输出摘要内容，不要加"好的"等客套话。请使用纯文本，严禁使用 Markdown 格式（如 **粗体**、# 标题等）。

    以下是之前的核心记忆存档，供你参考上下文（不需要重复总结这些内容）：
    === 📜 【核心记忆存档 (截止于 {checkpoint_date})】 ===
  no_context: |
    你是一位专业的档案管理员。现在是【{current_time}】。
    请将以下这段发生在【{date}】的对话概括为一个简短的摘要（{summary_max_length}字以内）。
    重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
    直接输出摘要内容，不要加"好的"等客套话。请使用纯文本，严禁使用 Markdown 格式（如 **粗体**、# 标题等）。

    对话内容：

# ============================================================
# 批量增量总结 Prompt
# 使用场景: #ai批量增量总结 命令
# 将多个未总结日期的摘要逐个与全量存档合并，生成连贯的记忆报告
# 占位符: {current_time}
# 代码会将全量存档内容和增量摘要追加在 prompt 末尾
# ============================================================
batch_incremental:
  with_base: |
    你是一位专业的传记作家和档案管理员。现在是【{current_time}】。
    这是一次【记忆存档接力 (Update)】操作。请基于旧的【核心记忆存档】，合并后续的【增量记忆】，生成一份**最新的**人生总结报告。**关键要求**：旧存档中的核心设定（背景、性格、长期经历）非常重要，请务必继承和保留，不要丢失细节。
    输出要求：
    1. 报告将作为**新的存档文件**保存，供未来使用，请确保信息密度高。
    2. 请用第三人称叙述。
    3. 重点关注：用户的性格变化、核心人际关系、重要事件的时间线。
    4. 严禁使用 Markdown 格式（如 **粗体**、# 标题等），请使用纯文本。

    --- 🗂️ 待处理数据 ---
  no_base: |
    你是一位专业的传记作家和档案管理员。现在是【{current_time}】。
    这是一次【记忆存档重构 (Rebuild)】操作。请阅读以下用户的【每日摘要】，将这些碎片化的信息整合成一份**完整的、连贯的**人生总结报告。
    输出要求：
    1. 报告将作为**新的存档文件**保存，供未来使用，请确保信息密度高。
    2. 请用第三人称叙述。
    3. 重点关注：用户的性格变化、核心人际关系、重要事件的时间线。
    4. 严禁使用 Markdown 格式（如 **粗体**、# 标题等），请使用纯文本。

    --- 🗂️ 待处理数据 ---

# ============================================================
# 每日摘要 Prompt（每8轮对话自动触发时的摘要生成）
# 使用场景: apps/chat.js 自动触发、定时任务中的每日摘要
# 代码会将对话内容追加在 prompt 末尾
# ============================================================
daily_summary: |
  请将以下这段发生在【{date}】的对话概括为一个简短的摘要（{summary_max_length}字以内）。
  重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
  直接输出摘要内容，不要加"好的"等客套话。请使用纯文本，严禁使用 Markdown 格式（如 **粗体**、# 标题等）。

  对话内容：
`
            fs.writeFileSync(PROMPTS_FILE, defaultPrompts, 'utf8')
        }
        const fileContent = fs.readFileSync(PROMPTS_FILE, 'utf8')
        return yaml.parse(fileContent)
    } catch (error) {
        logger.error(`[AI-Plugin] 加载提示词配置失败: ${error.message}`)
        return null
    }
}

let config = {}
const presets = loadPresetsSync()
const loadedAIName = loadAIName()
const loadedTrustedGroups = loadTrustedGroups()
const loadedPrompts = loadPrompts()

export const Config = {
    ...defaultConfig,
    presets,
    get Prompts() { return config.Prompts ?? loadedPrompts },
    set Prompts(val) { config.Prompts = val },
    get USE_PROXY() { return config.USE_PROXY ?? defaultConfig.USE_PROXY },
    set USE_PROXY(val) { config.USE_PROXY = val },
    get PROXY_URL() { return config.PROXY_URL ?? defaultConfig.PROXY_URL },
    set PROXY_URL(val) { config.PROXY_URL = val },
    get SUMMARY_THRESHOLD() { return config.SUMMARY_THRESHOLD ?? defaultConfig.SUMMARY_THRESHOLD },
    set SUMMARY_THRESHOLD(val) { config.SUMMARY_THRESHOLD = val },
    get HISTORY_TO_KEEP_AFTER_SUMMARY() { return config.HISTORY_TO_KEEP_AFTER_SUMMARY ?? defaultConfig.HISTORY_TO_KEEP_AFTER_SUMMARY },
    set HISTORY_TO_KEEP_AFTER_SUMMARY(val) { config.HISTORY_TO_KEEP_AFTER_SUMMARY = val },
    get SESSION_TIMEOUT_MS() { return config.SESSION_TIMEOUT_MS ?? defaultConfig.SESSION_TIMEOUT_MS },
    set SESSION_TIMEOUT_MS(val) { config.SESSION_TIMEOUT_MS = val },
    get SUMMARY_PROMPT_TEMPLATE() { return config.SUMMARY_PROMPT_TEMPLATE ?? defaultConfig.SUMMARY_PROMPT_TEMPLATE },
    set SUMMARY_PROMPT_TEMPLATE(val) { config.SUMMARY_PROMPT_TEMPLATE = val },
    get personaPrimer() {
        const aiName = config.AI_NAME ?? loadedAIName ?? defaultConfig.AI_NAME
        const prompts = this.Prompts
        return config.personaPrimer ?? buildPersonaPrimer(aiName, prompts)
    },
    set personaPrimer(val) { config.personaPrimer = val },
    get AI_NAME() { return config.AI_NAME ?? loadedAIName ?? defaultConfig.AI_NAME },
    set AI_NAME(val) { config.AI_NAME = val },
    get trustedGroups() { return config.trustedGroups ?? loadedTrustedGroups ?? defaultConfig.trustedGroups },
    set trustedGroups(val) { config.trustedGroups = val; saveTrustedGroups(val) },
    get MAX_HISTORY_LENGTH() { return config.MAX_HISTORY_LENGTH ?? defaultConfig.MAX_HISTORY_LENGTH },
    set MAX_HISTORY_LENGTH(val) { config.MAX_HISTORY_LENGTH = val },
    get MAX_IMAGES_PER_MESSAGE() { return config.MAX_IMAGES_PER_MESSAGE ?? defaultConfig.MAX_IMAGES_PER_MESSAGE },
    set MAX_IMAGES_PER_MESSAGE(val) { config.MAX_IMAGES_PER_MESSAGE = val },
    get MAX_IMAGE_SIZE_MB() { return config.MAX_IMAGE_SIZE_MB ?? defaultConfig.MAX_IMAGE_SIZE_MB },
    set MAX_IMAGE_SIZE_MB(val) { config.MAX_IMAGE_SIZE_MB = val },
    get MAX_IMAGE_RESIZE() { return config.MAX_IMAGE_RESIZE ?? defaultConfig.MAX_IMAGE_RESIZE },
    set MAX_IMAGE_RESIZE(val) { config.MAX_IMAGE_RESIZE = val },
    get IMAGE_QUALITY() { return config.IMAGE_QUALITY ?? defaultConfig.IMAGE_QUALITY },
    set IMAGE_QUALITY(val) { config.IMAGE_QUALITY = val },
    get REQUEST_SIZE_WARNING_MB() { return config.REQUEST_SIZE_WARNING_MB ?? defaultConfig.REQUEST_SIZE_WARNING_MB },
    set REQUEST_SIZE_WARNING_MB(val) { config.REQUEST_SIZE_WARNING_MB = val },
    get REQUEST_SIZE_LIMIT_MB() { return config.REQUEST_SIZE_LIMIT_MB ?? defaultConfig.REQUEST_SIZE_LIMIT_MB },
    set REQUEST_SIZE_LIMIT_MB(val) { config.REQUEST_SIZE_LIMIT_MB = val },
    get MIN_HISTORY_FOR_TRUNCATION() { return config.MIN_HISTORY_FOR_TRUNCATION ?? defaultConfig.MIN_HISTORY_FOR_TRUNCATION },
    set MIN_HISTORY_FOR_TRUNCATION(val) { config.MIN_HISTORY_FOR_TRUNCATION = val },
    get FORWARD_MSG_MAX_DEPTH() { return config.FORWARD_MSG_MAX_DEPTH ?? defaultConfig.FORWARD_MSG_MAX_DEPTH },
    set FORWARD_MSG_MAX_DEPTH(val) { config.FORWARD_MSG_MAX_DEPTH = val },
    get FORWARD_MSG_MAX_COUNT() { return config.FORWARD_MSG_MAX_COUNT ?? defaultConfig.FORWARD_MSG_MAX_COUNT },
    set FORWARD_MSG_MAX_COUNT(val) { config.FORWARD_MSG_MAX_COUNT = val },
    get SUMMARY_MAX_LENGTH() { return config.SUMMARY_MAX_LENGTH ?? defaultConfig.SUMMARY_MAX_LENGTH },
    set SUMMARY_MAX_LENGTH(val) { config.SUMMARY_MAX_LENGTH = val },
    get CHECKPOINT_MAX_LENGTH() { return config.CHECKPOINT_MAX_LENGTH ?? defaultConfig.CHECKPOINT_MAX_LENGTH },
    set CHECKPOINT_MAX_LENGTH(val) { config.CHECKPOINT_MAX_LENGTH = val },
    get CHECKPOINT_DISPLAY_MAX_LENGTH() { return config.CHECKPOINT_DISPLAY_MAX_LENGTH ?? defaultConfig.CHECKPOINT_DISPLAY_MAX_LENGTH },
    set CHECKPOINT_DISPLAY_MAX_LENGTH(val) { config.CHECKPOINT_DISPLAY_MAX_LENGTH = val },
    presets,
    reloadPresets() {
        this.presets = loadPresetsSync()
    },
    version: defaultConfig.version
}
