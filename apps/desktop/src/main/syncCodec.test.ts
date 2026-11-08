import { checkCodec } from '@flax/core'
import { expect, it } from 'vitest'
import { nodeCodec } from './syncCodec'

// 测试数据就是用这个实现生成的；以后改了这里，手机版也要跟着能对上
it('matches the shared codec vectors that every platform checks against', async () => {
  await expect(checkCodec(nodeCodec, true)).resolves.toBeUndefined()
})
