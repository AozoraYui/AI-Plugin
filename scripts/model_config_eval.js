import assert from 'node:assert/strict'
import yaml from 'yaml'
import { normalizeModelConfigDocuments, resolveModelReference } from '../utils/model_config.js'

const newFormat = yaml.parse(`
providers:
  - id: p1
    name: Provider 1
    base_url: https://one.example/v1
  - id: p2
    name: Provider 2
    base_url: https://two.example/v1
models:
  - id: vision
    alias: qwen-vl
    provider: p1
    model: vendor/vision
    multimodal: true
  - id: text
    alias: deepseek
    provider_id: p1
    model_identifier: vendor/text
    multimodal: false
  - id: duplicate
    alias: same
    provider: p2
    model: vendor/text
    visual: true
model_groups:
  flash:
    chat_models: [qwen-vl, deepseek]
    draw_models: []
`)

const normalized = normalizeModelConfigDocuments([newFormat])
assert.equal(normalized.legacy, false)
assert.equal(normalized.providers.length, 2)
assert.equal(normalized.definitions.length, 3)
assert.deepEqual(normalized.providers[0].model_groups.flash.chat_models, ['vision', 'text'])
assert.equal(resolveModelReference('qwen-vl', normalized.definitions, 'p1').model_id, 'vendor/vision')
assert.equal(resolveModelReference('vendor/text', normalized.definitions, 'p1').id, 'text')
assert.equal(resolveModelReference('vendor/text', normalized.definitions, 'p2').id, 'duplicate')
assert.equal(normalized.definitions.find(model => model.id === 'text').multimodal, false)
assert.equal(normalized.definitions.find(model => model.id === 'duplicate').multimodal, true)

const stringReference = normalizeModelConfigDocuments([{
    providers: [{ id: 'p3', name: 'Provider 3' }],
    models: [{ id: 'vision-3', provider: 'p3', model: 'vision-api' }],
    model_groups: { flash: { chat_models: ['vision-3'] } }
}])
assert.equal(stringReference.providers[0].model_groups.flash.chat_models[0], 'vision-3')

const legacy = yaml.parse(`
- id: legacy
  name: Legacy
  multimodal: false
  per_call_models: [legacy-text]
  model_groups:
    flash:
      chat_models: [legacy-text]
      draw_models: []
`)
const legacyNormalized = normalizeModelConfigDocuments([legacy])
assert.equal(legacyNormalized.legacy, true)
const legacyModel = legacyNormalized.definitions[0]
assert.equal(legacyModel.id, 'legacy-text')
assert.equal(legacyModel.model_id, 'legacy-text')
assert.equal(legacyModel.multimodal, false)
assert.equal(legacyModel.per_call, true)
assert.deepEqual(legacyNormalized.providers[0].model_groups.flash.chat_models, ['legacy-text'])

console.log('模型配置评估通过：独立模型、兼容别名、模型级能力与旧格式迁移均正常。')
