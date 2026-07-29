import fs from 'node:fs/promises'

const sourceUrl = 'https://raw.githubusercontent.com/koishijs/QFace/master/public/assets/qq_emoji/_index.json'
const outputUrl = new URL('../data/qq_face_map.json', import.meta.url)

const response = await fetch(sourceUrl)
if (!response.ok) {
    throw new Error(`QFace 索引下载失败: HTTP ${response.status}`)
}

const entries = await response.json()
if (!Array.isArray(entries)) {
    throw new Error('QFace 索引格式异常：顶层不是数组')
}

const faceMap = {}
for (const entry of entries) {
    const id = String(entry?.emojiId ?? '').trim()
    const name = String(entry?.describe ?? '').replace(/^\/+/, '').trim()
    if (id && name) faceMap[id] = name
}

await fs.writeFile(outputUrl, `${JSON.stringify(faceMap, null, 2)}\n`, 'utf8')
console.log(`QQ 表情映射已更新：${Object.keys(faceMap).length} 条`)
