import fs from 'node:fs'
import yaml from 'yaml'
import { ACCESS_CONTROL_FILE } from './config.js'
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
        fs.writeFileSync(ACCESS_CONTROL_FILE, yaml.stringify(defaultAccessConfig), 'utf8')
        return defaultAccessConfig
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
    fs.writeFileSync(ACCESS_CONTROL_FILE, yaml.stringify(config), 'utf8')
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
