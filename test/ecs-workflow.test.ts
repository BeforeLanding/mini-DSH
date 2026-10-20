import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// R11：发布与生产部署必须能分别运行和回退。tag/Release 不允许隐式触发部署。
test('ECS deployment is manual-only and no push/release trigger can deploy production', async () => {
  const workflow = await fs.readFile('.github/workflows/deploy-ecs.yml', 'utf8')
  const trigger = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'))
  assert.match(trigger, /workflow_dispatch:/)
  assert.doesNotMatch(trigger, /^\s+push:/m)
  assert.doesNotMatch(trigger, /^\s+release:/m)
  assert.doesNotMatch(trigger, /tags:/)
})
