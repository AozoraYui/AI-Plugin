import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'
import { ACCESS_CONTROL_FILE, TEMPLATE_DIR_EXPORT } from './config.js'
import { Config } from './config.js'

const defaultAccessConfig = {
    mode: 'whitelist',
    whitelist_groups: [],
    whitelist_users: [],
    blacklist_groups: [],
    blacklist_users: [],
    show_thinking: false
}

export function getAccessConfig() {
    if (!fs.existsSync(ACCESS_CONTROL_FILE)) {
        const templatePath = path.join(TEMPLATE_DIR_EXPORT, 'access_control.yaml')
        if (fs.existsSync(templatePath)) {
            fs.copyFileSync(templatePath, ACCESS_CONTROL_FILE)
        } else {
            fs.writeFileSync(ACCESS_CONTROL_FILE, yaml.stringify({ mode: 'whitelist' }), 'utf8')
        }
    }

    try {
        const userConfig = yaml.parse(fs.readFileSync(ACCESS_CONTROL_FILE, 'utf8')) || {}
        const finalConfig = { ...defaultAccessConfig, ...userConfig }

        for (const key of Object.keys(defaultAccessConfig)) {
            if (Array.isArray(defaultAccessConfig[key])) {
                finalConfig[key] = finalConfig[key] || []
            }
        }
        return finalConfig
    } catch (error) {
        logger.error(`[AI-Plugin] 解析 access_control.yaml 失败: ${error.message}`)
        return defaultAccessConfig
    }
}

export function saveAccessConfig(config) {
    const tempFile = ACCESS_CONTROL_FILE + '.tmp'
    try {
        fs.writeFileSync(tempFile, yaml.stringify(config), 'utf8')
        fs.renameSync(tempFile, ACCESS_CONTROL_FILE)
    } catch (error) {
        logger.error(`[AI-Plugin] 保存权限配置失败: ${error.message}`)
        try {
            fs.unlinkSync(tempFile)
        } catch (e) {
            // 忽略清理错误
        }
        throw error
    }
}

export async function checkAccess(e) {
    if (e.isMaster) {
        return true
    }

    const config = getAccessConfig()
    const unauthorizedMsg = "抱歉哦，" + Config.AI_NAME + "暂时还不能在这里或为你提供这项服务呢~ (´-ω-`)"

    if (e.isGroup) {
        const groupId = String(e.group_id)
        if (config.mode === 'whitelist') {
            if (!config.whitelist_groups.includes(groupId)) return false
        } else {
            if (config.blacklist_groups.includes(groupId)) return false
        }
    } else {
        const userId = String(e.user_id)
        if (config.mode === 'whitelist') {
            if (!config.whitelist_users.includes(userId)) {
                e.reply(unauthorizedMsg, true)
                return false
            }
        } else {
            if (config.blacklist_users.includes(userId)) {
                e.reply(unauthorizedMsg, true)
                return false
            }
        }
    }

    return true
}
