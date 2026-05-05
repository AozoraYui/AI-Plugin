import https from 'https'
import http from 'http'
import fs from 'node:fs'
import path from 'node:path'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { Config } from './config.js'

const AI_ERROR_PATTERNS = [
    'AI Studio 过滤了你的请求内容',
    '无法生成回复',
    '内容安全策略',
    'content filter',
    'safety filter',
    'blocked by safety',
    'I cannot generate',
    'I am unable to',
    'I\'m unable to',
]

export function isAIErrorResponse(text) {
    if (!text || !text.trim()) return true
    const lowerText = text.toLowerCase()
    return AI_ERROR_PATTERNS.some(pattern => lowerText.includes(pattern.toLowerCase()))
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export async function setMsgEmojiLike(e, emojiID) {
    if (e.isPrivate) return
    if (!e || !e.bot || !e.message_id || emojiID === undefined || emojiID === null) {
        logger.warn(`[AI-Plugin] [setMsgEmojiLike] 调用失败：缺少必要参数`)
        return
    }
    try {
        await e.bot.sendApi('set_msg_emoji_like', {
            message_id: e.message_id,
            emoji_id: emojiID,
            set: true
        })
    } catch (emojiErr) {
        // 忽略错误
    }
}

export async function fetchWithProxy(url, options = {}) {
    const agent = Config.USE_PROXY ? new HttpsProxyAgent(Config.PROXY_URL) : null
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url)
        const httpModule = urlObj.protocol === 'https:' ? https : http
        const requestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            agent: agent,
            timeout: 600000
        }
        const req = httpModule.request(requestOptions, (res) => {
            const chunks = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => {
                const buffer = Buffer.concat(chunks)
                const data = buffer.toString()
                const jsonResponse = () => {
                    try {
                        return Promise.resolve(JSON.parse(data))
                    } catch (e) {
                        return Promise.reject(new Error(`Invalid JSON: ${data}`))
                    }
                }
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    text: () => Promise.resolve(data),
                    json: jsonResponse,
                    arrayBuffer: () => Promise.resolve(buffer)
                })
            })
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
        if (options.body) req.write(options.body)
        req.end()
    })
}

export async function urlToBuffer(url) {
    const res = await fetchWithProxy(url)
    if (!res.ok) throw new Error(`获取图片失败: ${res.status}`)
    return await res.arrayBuffer()
}

export function getImageMimeType(buffer) {
    const header = buffer.subarray(0, 4).toString('hex')
    if (header.startsWith('89504e47')) return 'image/png'
    if (header.startsWith('ffd8')) return 'image/jpeg'
    if (header.startsWith('47494638')) return 'image/gif'
    if (header.startsWith('52494646')) return 'image/webp'
    return null
}

export function getTodayDateStr() {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export function getBeijingTime() {
    const now = new Date()
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    return beijingTime
}

export function getBeijingTimeStr() {
    const beijingTime = getBeijingTime()
    return beijingTime.toISOString().replace('T', ' ').substring(0, 19) + ' (北京时间)'
}

export function getDBTimestamp() {
    const now = new Date()
    const year = now.getUTCFullYear()
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    const day = String(now.getUTCDate()).padStart(2, '0')
    const hours = String(now.getUTCHours()).padStart(2, '0')
    const minutes = String(now.getUTCMinutes()).padStart(2, '0')
    const seconds = String(now.getUTCSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

export async function generateDailySummary(client, userId, dateDir, dayHistory, modelGroupKey = 'default') {
    if (dayHistory.length === 0) return ""

    let dayContent = ""
    const aiName = Config.AI_NAME || '诺亚'
    for (const turn of dayHistory) {
        const role = turn.role === 'user' ? '用户' : aiName
        const text = turn.parts.map(p => p.text).join(' ')
        if (text) dayContent += `${role}: ${text}\n`
    }

    if (!dayContent.trim()) return ""

    // 从数据库获取摘要缓存
    const dbSummary = await global.AIPluginConversationManager.db.getSummaryCache(userId, dateDir)
    if (dbSummary) {
        return dbSummary.content
    }

    logger.info(`[AI-Plugin] 正在为 ${dateDir} 生成新摘要...`)
    const summaryPrompt = `
请将以下这段发生在【${dateDir}】的对话概括为一个简短的摘要（${Config.SUMMARY_MAX_LENGTH}字以内）。
重点记录：用户做了什么、讨论了什么话题、用户的情绪或重要偏好。
直接输出摘要内容，不要加"好的"等客套话。
对话内容：
${dayContent}`

    const payload = { "contents": [{ "role": "user", "parts": [{ "text": summaryPrompt }] }] }
    const result = await client.makeRequest('chat', payload, modelGroupKey, Config.CHECKPOINT_MAX_LENGTH)

    if (result.success && !isAIErrorResponse(result.data)) {
        const summaryText = result.data.trim()
        await global.AIPluginConversationManager.db.saveSummaryCache(userId, summaryText, dateDir)
        return summaryText
    } else {
        const reason = isAIErrorResponse(result.data) ? 'AI 安全过滤拦截' : (result.error || '未知错误')
        logger.warn(`[AI-Plugin] ${dateDir} 摘要生成失败: ${reason}`)
        return `【${dateDir} 原始片段】: ${dayContent.slice(0, 500)}...`
    }
}

export async function getAvatarUrl(qq) {
    return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`
}

export async function takeSourceMsg(e, { img } = {}) {
    let source = null
    if (typeof e.getReply === 'function') source = await e.getReply()
    else if (e.source) {
        if (e.group?.getChatHistory) source = (await e.group.getChatHistory(e.source.seq, 1))?.pop()
        else if (e.friend?.getChatHistory) source = (await e.friend.getChatHistory(e.source.time, 1))?.pop()
    }
    if (!source) return false
    if (img) {
        const imgArr = source.message?.filter(s => s.type === "image" && s.url).map(s => s.url) || []
        return imgArr.length > 0 ? imgArr : false
    }
    return source
}

export function parseModelGroup(e) {
    let modelGroupKey = 'default'
    let cleanedMsg = e.msg

    const match = e.msg.match(/^#([a-zA-Z0-9]*)(.*)/)

    if (match) {
        const prefix = match[1].toLowerCase()
        const commandAndArgs = match[2]

        if (prefix === 'pro') {
            modelGroupKey = 'pro'
        } else if (prefix === '3') {
            modelGroupKey = 'gemini3'
        }

        if (modelGroupKey !== 'default') {
            cleanedMsg = `#${commandAndArgs}`
        }
    }

    return { modelGroupKey, cleanedMsg }
}
