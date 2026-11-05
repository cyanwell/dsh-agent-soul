// 不指定构图时保留原 size；只映射明确选择的构图，不替接口静默改尺寸。
export const SHAPE_SIZE = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
  wide: '1536x864',
}

export function pickShape(shape, config) {
  if (Object.hasOwn(SHAPE_SIZE, shape)) return shape
  return Object.hasOwn(SHAPE_SIZE, config.shape) ? config.shape : 'her'
}

export function imageSizeFor(shape, config) {
  return SHAPE_SIZE[pickShape(shape, config)] || config.size
}
