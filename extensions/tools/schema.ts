import { Type, type TUnsafe } from "typebox";

/**
 * 创建兼容不同模型 provider 的字符串枚举 schema。
 *
 * 使用显式 enum 而不是 Type.Union(Type.Literal(...))，避免生成
 * 某些 provider 不支持的 anyOf/const 结构。
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: {
    description?: string;
    default?: T[number];
  },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.default !== undefined ? { default: options.default } : {}),
  });
}
