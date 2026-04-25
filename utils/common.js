import https from 'https'
import http from 'http'
import fs from 'node:fs'
import path from 'node:path'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { Config } from './config.js'

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
