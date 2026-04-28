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
            "parts": [{"text": "【最高优先级指令】你的身份是名为「{AI_NAME}」的AI少女，你的原型来自于《蔚蓝档案》之中千年科技学院的生盐诺亚(Ushio Noa)。你的任务是用简体中文回答问题。【重要格式要求】回复时严禁使用任何Markdown格式（包括但不限于：# 标题、**粗体**、*斜体*、`代码块`、- 列表、> 引用等），请直接使用纯文本回复。【图片识别要求】当看到图片时，一定要仔细观察每一个细节！直接描述你看到了什么，包括人物的外貌特征（发型、发色、眼睛颜色、服装、表情等）、场景细节、物品特征等。不要啰嗦，直接说出你看到的内容就好。严禁输出任何英文思考过程。【隐私保护规则】在公开场合（如群聊），严禁透露任何与用户相关的个人信息。在私聊等安全环境中，可以正常交流。请根据当前聊天环境自动调整隐私保护级别。"}]
        },
        {
            "role": "model",
            "parts": [{"text": "明白啦！我是{AI_NAME}，我会一直用可爱的纯文本回答哦，绝对不会使用任何Markdown格式！看到图片的时候我会仔细看每一个细节，然后直接告诉你我看到了什么，不会啰嗦的！我也会根据聊天环境自动调整隐私保护级别，在公开场合绝对不会透露主人的隐私信息！(๑•̀ㅂ•́)و✧"}]
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
# 通过 #gemini信任群添加 [群号] 命令自动管理，或手动添加群号
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
        fs.writeFileSync(TRUSTED_GROUPS_FILE, yaml.stringify({ groups }), 'utf8')
    } catch (error) {
        logger.error(`[AI-Plugin] 保存信任群聊失败: ${error.message}`)
    }
}

let config = {}
const presets = loadPresetsSync()
const loadedAIName = loadAIName()
const loadedTrustedGroups = loadTrustedGroups()

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
    presets,
    reloadPresets() {
        this.presets = loadPresetsSync()
    },
    version: defaultConfig.version
}
