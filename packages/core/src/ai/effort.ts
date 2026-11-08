// 思考深度：不同模型能选的不一样。Anthropic 的模型列表会说明每个模型支持哪几档；
// OpenAI 兼容服务一般不说（OpenRouter 这类会给 supported_parameters），不知道时按服务类型给常见的几档。
import type { AiEffort, AiModel } from './types'
import type { AiVendorKind } from './vendors'

export type EffortLevel = Exclude<AiEffort, 'auto'>
/** 从浅到深 */
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** 这个模型能选的深度。空数组：这个模型不能调 */
export function levelsFor(kind: AiVendorKind, model?: AiModel): EffortLevel[] {
  if (model?.efforts) return EFFORT_LEVELS.filter((l) => model.efforts!.includes(l))
  return kind === 'anthropic' ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high']
}

/** 用户选的深度在这个模型上实际用哪一档：没有这档就用比它浅的最近一档；不指定时返回 undefined */
export function resolveEffort(want: AiEffort, levels: EffortLevel[]): EffortLevel | undefined {
  if (want === 'auto' || levels.length === 0) return undefined
  if (levels.includes(want)) return want
  for (let i = EFFORT_LEVELS.indexOf(want); i >= 0; i--) if (levels.includes(EFFORT_LEVELS[i]!)) return EFFORT_LEVELS[i]
  return levels[0]
}
