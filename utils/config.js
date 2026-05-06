import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'

const _path = process.cwd()
const DATA_DIR = path.join(_path, 'plugins', 'AI-Plugin', 'config')
const TEMPLATE_DIR = path.join(_path, 'plugins', 'AI-Plugin', 'config_template')

const defaultConfig = {
    USE_PROXY: false,
    PROXY_URL: "http://127.0.0.1:7890",
    SUMMARY_THRESHOLD: 20,
    HISTORY_TO_KEEP_AFTER_SUMMARY: 10,
    SESSION_TIMEOUT_MS: 180000,
    SUMMARY_PROMPT_TEMPLATE: "请你扮演一个总结者的角色，用简洁的语言概括以下用户与AI助手之间的一段对话历史的核心主题、关键信息和重要结论。摘要应该只包含事实信息，并能帮助AI助手在后续对话中回忆起重要的上下文。请用中文输出摘要。对话历史：\n\n",
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
export const TEMPLATE_DIR_EXPORT = TEMPLATE_DIR

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true })
    }
}

function copyFromTemplate(templateName, targetFile, label) {
    const templatePath = path.join(TEMPLATE_DIR, templateName)
    if (fs.existsSync(templatePath)) {
        fs.copyFileSync(templatePath, targetFile)
        logger.info(`[AI-Plugin] 已从模板创建 ${label}: ${targetFile}`)
        return true
    }
    logger.warn(`[AI-Plugin] 模板文件不存在: ${templatePath}`)
    return false
}

function loadPresetsSync() {
    ensureDataDir()
    try {
        if (!fs.existsSync(PRESETS_FILE)) {
            logger.info(`[AI-Plugin] 未找到预设文件，将从模板创建。`)
            copyFromTemplate('draw_presets.yaml', PRESETS_FILE, '作图预设配置')
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
            logger.info(`[AI-Plugin] 未找到 AI 名称配置文件，将从模板创建。`)
            ensureDataDir()
            copyFromTemplate('ai_name.yaml', AI_NAME_FILE, 'AI 名称配置')
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
            logger.info(`[AI-Plugin] 未找到信任群配置文件，将从模板创建。`)
            ensureDataDir()
            copyFromTemplate('trusted_groups.yaml', TRUSTED_GROUPS_FILE, '信任群配置')
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
            logger.info(`[AI-Plugin] 未找到提示词配置文件，将从模板创建。`)
            copyFromTemplate('ai_prompt.yaml', PROMPTS_FILE, '提示词配置')
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
        const aiName = config.AI_NAME ?? loadedAIName ?? '诺亚'
        const prompts = this.Prompts
        return config.personaPrimer ?? buildPersonaPrimer(aiName, prompts)
    },
    set personaPrimer(val) { config.personaPrimer = val },
    get AI_NAME() { return config.AI_NAME ?? loadedAIName ?? '诺亚' },
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
