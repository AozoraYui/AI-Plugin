/**
 * 天气查询工具
 * 使用高德地图 API 查询指定城市的实时天气和未来预报
 */

import { toolRegistry } from './registry.js'

/**
 * 查询天气
 * @param {string} city - 城市名称
 * @param {string} apiKey - 高德 API Key
 * @returns {Promise<string>}
 */
async function queryWeather(city, apiKey) {
    if (!city || !city.trim()) {
        return '\n\n【天气查询失败】未指定城市名称。\n'
    }

    const cityName = city.trim()
    const url = `https://restapi.amap.com/v3/weather/weatherInfo?key=${apiKey}&city=${encodeURIComponent(cityName)}&extensions=all`

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
        const data = await res.json()

        // extensions=all 失败时，尝试地理编码获取 adcode 后重试
        if (data.status !== '1' || !data.forecasts || data.forecasts.length === 0) {
            logger.warn(`[AI-Plugin] 天气查询 extensions=all 城市名失败: ${data.info}，尝试地理编码`)
            const geoUrl = `https://restapi.amap.com/v3/geocode/geo?key=${apiKey}&address=${encodeURIComponent(cityName)}`
            const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(5000) })
            const geoData = await geoRes.json()

            if (geoData.status === '1' && geoData.geocodes && geoData.geocodes.length > 0) {
                const adcode = geoData.geocodes[0].adcode
                const retryUrl = `https://restapi.amap.com/v3/weather/weatherInfo?key=${apiKey}&city=${adcode}&extensions=all`
                const retryRes = await fetch(retryUrl, { signal: AbortSignal.timeout(10000) })
                const retryData = await retryRes.json()

                if (retryData.status === '1' && retryData.forecasts && retryData.forecasts.length > 0) {
                    const forecasts = retryData.forecasts[0]
                    const casts = forecasts.casts || []
                    if (casts.length > 0) {
                        let text = `\n\n【以下是从高德地图获取的天气预报数据：】\n\n📍 城市：${forecasts.city}（${forecasts.province}）\n`
                        for (const day of casts) {
                            text += `\n📅 ${day.date} 星期${day.week}\n`
                            text += `   ☀️ 白天：${day.dayweather}，${day.daytemp}℃，${day.daywind}风 ${day.daypower}级\n`
                            text += `   🌙 夜间：${day.nightweather}，${day.nighttemp}℃，${day.nightwind}风 ${day.nightpower}级\n`
                        }
                        text += `\n【天气数据结束】\n`
                        return text
                    }
                }
            }

            // 地理编码也失败，降级到 base 实时天气
            logger.warn(`[AI-Plugin] 天气查询地理编码重试也失败，降级到 base`)
            const baseUrl = `https://restapi.amap.com/v3/weather/weatherInfo?key=${apiKey}&city=${encodeURIComponent(cityName)}&extensions=base`
            const baseRes = await fetch(baseUrl, { signal: AbortSignal.timeout(10000) })
            const baseData = await baseRes.json()

            if (baseData.status !== '1' || !baseData.lives || baseData.lives.length === 0) {
                return `\n\n【天气查询失败】未能查询到 "${cityName}" 的天气信息。（${baseData.info || '无有效数据'}）\n`
            }

            const live = baseData.lives[0]
            let text = `\n\n【以下是从高德地图获取的实时天气数据：】\n\n`
            text += `📍 城市：${live.city}（${live.province}）\n`
            text += `   🌡️ 温度：${live.temperature}℃（湿度 ${live.humidity}%）\n`
            text += `   🌤️ 天气：${live.weather}\n`
            text += `   💨 风向风力：${live.winddirection}风 ${live.windpower}级\n`
            text += `   🕐 更新时间：${live.reporttime}\n`
            text += `\n【天气数据结束】\n`
            return text
        }

        const forecasts = data.forecasts[0]
        const casts = forecasts.casts || []

        if (casts.length === 0) {
            return `\n\n【天气查询】查询到城市 "${forecasts.city}"，但没有具体的预报数据。\n`
        }

        let text = `\n\n【以下是从高德地图获取的实时天气数据：】\n\n📍 城市：${forecasts.city}（${forecasts.province}）\n`

        for (const day of casts) {
            text += `\n📅 ${day.date} 星期${day.week}\n`
            text += `   ☀️ 白天：${day.dayweather}，${day.daytemp}℃，${day.daywind}风 ${day.daypower}级\n`
            text += `   🌙 夜间：${day.nightweather}，${day.nighttemp}℃，${day.nightwind}风 ${day.nightpower}级\n`
        }

        text += `\n【天气数据结束】\n`
        return text

    } catch (err) {
        logger.error(`[AI-Plugin] 天气查询异常: ${err.message}`)
        return `\n\n【天气查询失败】网络请求异常：${err.message}\n`
    }
}

export const weatherTool = {
    name: 'weather',
    permission: 'all',
    description: '查询指定城市的实时天气和未来几天预报（温度、天气状况、风力风向等）。当用户询问天气时使用。',

    functionSchema: {
        type: 'function',
        function: {
            name: 'weather',
            description: '查询指定城市的实时天气和未来几天预报',
            parameters: {
                type: 'object',
                properties: {
                    city: {
                        type: 'string',
                        description: '城市名称，如"北京"、"中山"、"深圳"'
                    }
                },
                required: ['city']
            }
        }
    },

    async execute(args) {
        const apiKey = toolRegistry.weatherApiKey
        if (!apiKey) {
            return '\n\n【天气查询失败】未配置高德地图 API Key，请联系管理员。\n'
        }
        const city = args.city || args.query || ''
        return await queryWeather(city, apiKey)
    },

    formatResult(data) {
        return data
    }
}

// 自动注册
toolRegistry.register(weatherTool)