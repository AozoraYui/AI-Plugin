/**
 * 天气查询工具
 * 优先使用高德地图 API，失败时降级到 OpenWeatherMap
 */

import { toolRegistry } from './registry.js'

/**
 * OpenWeatherMap 天气查询
 */
async function queryOpenWeatherMap(city, apiKey) {
    try {
        // 当前天气
        const currUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=zh_cn`
        const currRes = await fetch(currUrl, { signal: AbortSignal.timeout(10000) })
        const currData = await currRes.json()

        if (currData.cod !== 200) {
            return `\n\n【OpenWeatherMap 查询失败】${currData.message || '未知错误'}\n`
        }

        let text = `\n\n【以下是从 OpenWeatherMap 获取的天气数据：】\n\n`
        text += `📍 城市：${currData.name}（${currData.sys?.country || ''}）\n`
        text += `   🌡️ 温度：${Math.round(currData.main.temp)}℃（体感 ${Math.round(currData.main.feels_like)}℃）\n`
        text += `   💧 湿度：${currData.main.humidity}%\n`
        text += `   🌤️ 天气：${currData.weather[0].description}\n`
        text += `   💨 风速：${currData.wind.speed} m/s\n`
        text += `   📊 气压：${currData.main.pressure} hPa\n`

        // 预报（5天/3小时）
        try {
            const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric&lang=zh_cn&cnt=16`
            const fcRes = await fetch(forecastUrl, { signal: AbortSignal.timeout(10000) })
            const fcData = await fcRes.json()

            if (fcData.cod === '200' && fcData.list) {
                text += `\n📅 未来预报（每3小时）：\n`
                for (const item of fcData.list) {
                    const dt = item.dt_txt.replace(' ', ' ') // 2026-06-19 12:00:00 → 2026-06-19 12:00
                    text += `   ${dt} | ${item.weather[0].description} | ${Math.round(item.main.temp)}℃\n`
                }
            }
        } catch (_) { /* 预报接口失败不影响当前天气 */ }

        text += `\n【天气数据结束】\n`
        return text

    } catch (err) {
        return `\n\n【OpenWeatherMap 查询失败】网络异常：${err.message}\n`
    }
}

/**
 * 查询天气（高德优先，失败降级 OpenWeatherMap）
 * @param {string} city - 城市名称
 * @param {string} amapKey - 高德 API Key
 * @param {string} owmKey - OpenWeatherMap API Key（可选）
 * @returns {Promise<string>}
 */
async function queryWeather(city, amapKey, owmKey = null) {
    if (!city || !city.trim()) {
        return '\n\n【天气查询失败】未指定城市名称。\n'
    }

    const cityName = city.trim()

    // Step 1: 高德 extensions=all（城市名）
    if (amapKey) {
        try {
            const url = `https://restapi.amap.com/v3/weather/weatherInfo?key=${amapKey}&city=${encodeURIComponent(cityName)}&extensions=all`
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
            const data = await res.json()

            if (data.status === '1' && data.forecasts && data.forecasts.length > 0) {
                const forecasts = data.forecasts[0]
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
                // all 成功但无预报数据，直接降级 base
                logger.warn(`[AI-Plugin] 天气查询 高德all返回空预报，降级到 base`)
                const baseUrl = `https://restapi.amap.com/v3/weather/weatherInfo?key=${amapKey}&city=${encodeURIComponent(cityName)}&extensions=base`
                const baseRes = await fetch(baseUrl, { signal: AbortSignal.timeout(10000) })
                const baseData = await baseRes.json()
                if (baseData.status === '1' && baseData.lives && baseData.lives.length > 0) {
                    const live = baseData.lives[0]
                    let text2 = `\n\n【以下是从高德地图获取的实时天气数据：】\n\n`
                    text2 += `📍 城市：${live.city}（${live.province}）\n`
                    text2 += `   🌡️ 温度：${live.temperature}℃（湿度 ${live.humidity}%）\n`
                    text2 += `   🌤️ 天气：${live.weather}\n`
                    text2 += `   💨 风向风力：${live.winddirection}风 ${live.windpower}级\n`
                    text2 += `   🕐 更新时间：${live.reporttime}\n`
                    text2 += `\n【天气数据结束】\n`
                    return text2
                }
                logger.warn(`[AI-Plugin] 天气查询 高德base也失败: ${baseData.info}`)
            }

            // Step 2: 地理编码获取 adcode 后重试
            logger.warn(`[AI-Plugin] 天气查询 高德all城市名失败: ${data.info}，尝试地理编码`)
            const geoUrl = `https://restapi.amap.com/v3/geocode/geo?key=${amapKey}&address=${encodeURIComponent(cityName)}`
            const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(5000) })
            const geoData = await geoRes.json()

            if (geoData.status === '1' && geoData.geocodes && geoData.geocodes.length > 0) {
                const adcode = geoData.geocodes[0].adcode
                const retryUrl = `https://restapi.amap.com/v3/weather/weatherInfo?key=${amapKey}&city=${adcode}&extensions=all`
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

            // Step 3: 降级到 base 实时天气
            logger.warn(`[AI-Plugin] 天气查询 高德地理编码也失败，降级到 base`)
            const baseUrl = `https://restapi.amap.com/v3/weather/weatherInfo?key=${amapKey}&city=${encodeURIComponent(cityName)}&extensions=base`
            const baseRes = await fetch(baseUrl, { signal: AbortSignal.timeout(10000) })
            const baseData = await baseRes.json()

            if (baseData.status === '1' && baseData.lives && baseData.lives.length > 0) {
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

            logger.warn(`[AI-Plugin] 天气查询 高德base也失败: ${baseData.info}`)
        } catch (err) {
            logger.warn(`[AI-Plugin] 天气查询 高德异常: ${err.message}`)
        }
    }

    // Step 4: 降级到 OpenWeatherMap
    if (owmKey) {
        logger.info(`[AI-Plugin] 天气查询 高德全部失败，降级到 OpenWeatherMap`)
        return await queryOpenWeatherMap(cityName, owmKey)
    }

    return `\n\n【天气查询失败】未能查询到 "${cityName}" 的天气信息，所有数据源均不可用。\n`
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
                        description: '城市名称，如"北京"、"中山"、"深圳"、"Tokyo"'
                    }
                },
                required: ['city']
            }
        }
    },

    async execute(args) {
        const amapKey = toolRegistry.weatherApiKey
        const owmKey = toolRegistry.openWeatherMapApiKey
        if (!amapKey && !owmKey) {
            return '\n\n【天气查询失败】未配置任何天气 API Key，请联系管理员。\n'
        }
        const city = args.city || args.query || ''
        return await queryWeather(city, amapKey, owmKey)
    },

    formatResult(data) {
        return data
    }
}

// 自动注册
toolRegistry.register(weatherTool)