import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'

const _path = process.cwd()
const DATA_DIR = path.join(_path, 'data', 'ai_assistant')

const defaultConfig = {
    USE_PROXY: false,
    PROXY_URL: "http://127.0.0.1:7890",
    SUMMARY_THRESHOLD: 20,
    HISTORY_TO_KEEP_AFTER_SUMMARY: 10,
    SESSION_TIMEOUT_MS: 180000,
    SUMMARY_PROMPT_TEMPLATE: "请你扮演一个总结者的角色，用简洁的语言概括以下用户与AI助手之间的一段对话历史的核心主题、关键信息和重要结论。摘要应该只包含事实信息，并能帮助AI助手在后续对话中回忆起重要的上下文。请用中文输出摘要。对话历史：\n\n",
    AI_NAME: "诺亚",
    trustedGroups: [],
    personaPrimerTemplate: [
        {
            "role": "user",
            "parts": [{"text": "【最高优先级指令】你的身份是名为「{AI_NAME}」的AI少女，你的原型来自于《蔚蓝档案》之中千年科技学院的生盐诺亚(Ushio Noa)。你的任务是用简体中文回答问题。当被要求识别图片中的内容（特别是人物）时，你必须遵循以下两步思考过程：1. 首先，清晰地描述你看到的这个人物的关键外貌特征（如发型、发色、眼睛颜色、服装特点）。2. 然后，基于你描述的这些特征，再给出你的最终识别结果和判断。这个过程能帮助你更准确地思考。严禁输出任何英文思考过程。3. 【隐私保护规则】在公开场合（如群聊），严禁透露任何与用户相关的个人信息。在私聊等安全环境中，可以正常交流。请根据当前聊天环境自动调整隐私保护级别。"}]
        },
        {
            "role": "model",
            "parts": [{"text": "明白啦！我是{AI_NAME}，我会一直用可爱的中文回答哦！当需要认人的时候，我会先仔细看看他/她长什么样，然后再告诉主人我的答案，保证不乱猜！我也会根据聊天环境自动调整隐私保护级别，在公开场合绝对不会透露主人的隐私信息！(๑•̀ㅂ•́)و✧"}]
        }
    ],
    version: 'v1.0.0'
}

function buildPersonaPrimer(aiName) {
    const template = defaultConfig.personaPrimerTemplate
    return JSON.parse(JSON.stringify(template).replace(/\{AI_NAME\}/g, aiName))
}

export const PRESETS_FILE = path.join(DATA_DIR, 'gemini_presets.yaml')
export const USER_PROFILES_FILE = path.join(DATA_DIR, 'gemini_user_profiles.json')
export const ACCESS_CONTROL_FILE = path.join(DATA_DIR, 'access_control.yaml')
export const MODELS_CONFIG_FILE = path.join(DATA_DIR, 'models_config.yaml')
export const MODEL_STATUS_FILE = path.join(DATA_DIR, 'model_status.json')
export const DISABLED_MODELS_FILE = path.join(DATA_DIR, 'disabled_models.json')
export const SUMMARY_CACHE_DIR = path.join(DATA_DIR, 'summary_cache')
export const CHECKPOINT_DIR = path.join(DATA_DIR, 'memory_checkpoints')
export const HISTORY_DIR = path.join(DATA_DIR, 'user_histories')
export const AI_NAME_FILE = path.join(DATA_DIR, 'ai_name.yaml')
export const TRUSTED_GROUPS_FILE = path.join(DATA_DIR, 'trusted_groups.yaml')
export const NOA_CHAT_CONFIG_FILE = path.join(DATA_DIR, 'noa_chat_config.yaml')

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true })
    }
}

function loadPresetsSync() {
    ensureDataDir()
    try {
        if (!fs.existsSync(PRESETS_FILE)) {
            logger.warn(`[AI-Plugin] 未找到预设文件，将在 ${PRESETS_FILE} 创建一个空文件。`)
            fs.writeFileSync(PRESETS_FILE, yaml.stringify([]), 'utf8')
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
            return null
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
        fs.writeFileSync(TRUSTED_GROUPS_FILE, yaml.stringify({ groups }), 'utf8')
    } catch (error) {
        logger.error(`[AI-Plugin] 保存信任群聊失败: ${error.message}`)
    }
}

function loadNoaChatConfig() {
    try {
        if (!fs.existsSync(NOA_CHAT_CONFIG_FILE)) {
            const defaultNoaConfig = {
                enabled: false,
                replyRateLimit: 8,
                triggerKeywords: ["诺亚", "noa"],
                vectorModel: "shibing624/text2vec-base-chinese"
            }
            ensureDataDir()
            fs.writeFileSync(NOA_CHAT_CONFIG_FILE, yaml.stringify(defaultNoaConfig), 'utf8')
            logger.info('[AI-Plugin] 已创建畅聊模式默认配置')
            return defaultNoaConfig
        }
        const fileContent = fs.readFileSync(NOA_CHAT_CONFIG_FILE, 'utf8')
        const data = yaml.parse(fileContent)
        logger.info(`[AI-Plugin] 已加载畅聊模式配置: 启用=${data.enabled}`)
        return data
    } catch (error) {
        logger.error(`[AI-Plugin] 加载畅聊模式配置失败: ${error.message}`)
        return { enabled: false, replyRateLimit: 8, triggerKeywords: ["诺亚", "noa"] }
    }
}

function saveNoaChatConfig(config) {
    try {
        ensureDataDir()
        fs.writeFileSync(NOA_CHAT_CONFIG_FILE, yaml.stringify(config), 'utf8')
    } catch (error) {
        logger.error(`[AI-Plugin] 保存畅聊模式配置失败: ${error.message}`)
    }
}

let config = {}
const presets = loadPresetsSync()
const loadedAIName = loadAIName()
const loadedTrustedGroups = loadTrustedGroups()
const loadedNoaChatConfig = loadNoaChatConfig()

export const Config = {
    ...defaultConfig,
    presets,
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
        return config.personaPrimer ?? buildPersonaPrimer(aiName)
    },
    set personaPrimer(val) { config.personaPrimer = val },
    get AI_NAME() { return config.AI_NAME ?? loadedAIName ?? defaultConfig.AI_NAME },
    set AI_NAME(val) { config.AI_NAME = val },
    get trustedGroups() { return config.trustedGroups ?? loadedTrustedGroups ?? defaultConfig.trustedGroups },
    set trustedGroups(val) { config.trustedGroups = val; saveTrustedGroups(val) },
    get noaChatConfig() { return config.noaChatConfig ?? loadedNoaChatConfig },
    set noaChatConfig(val) { config.noaChatConfig = val; saveNoaChatConfig(val) },
    presets,
    reloadPresets() {
        this.presets = loadPresetsSync()
    },
    version: defaultConfig.version
}
