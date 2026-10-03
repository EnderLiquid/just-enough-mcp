/**
 * DCR `client_name` 的默认值与校验规则。
 *
 * 该模块同时被宿主无关配置层与 broker identity 边界使用：配置层校验
 * `oauth.clientName`，identity 层在归一化点填充默认值。为避免两处规则漂移，
 * 校验只在这里实现。
 *
 * broker 子树由 Node 原生 type stripping 执行并依赖本模块，因此保持
 * erasable TypeScript syntax；broker 内引用使用显式 `.ts` 后缀。
 */

export const DEFAULT_OAUTH_CLIENT_NAME = "just-enough-mcp";

/** 按 code point 计数的上限，避免超长名称进入 identity 与注册请求。 */
const MAX_OAUTH_CLIENT_NAME_CODE_POINTS = 256;

/** C0 与 C1 控制字符。 */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * 校验一个已提供的 client name 并返回 trim 后的规范值；非法值抛 TypeError。
 */
export function validateOAuthClientName(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new TypeError(`${fieldName} must not contain control characters.`);
  }
  if ([...normalized].length > MAX_OAUTH_CLIENT_NAME_CODE_POINTS) {
    throw new TypeError(
      `${fieldName} must be at most ${MAX_OAUTH_CLIENT_NAME_CODE_POINTS} characters.`,
    );
  }
  return normalized;
}

/**
 * 解析可选配置：未配置时返回默认名称，已提供值经校验后返回。
 */
export function resolveOAuthClientName(
  value: unknown,
  fieldName = "clientName",
): string {
  return value === undefined || value === null
    ? DEFAULT_OAUTH_CLIENT_NAME
    : validateOAuthClientName(value, fieldName);
}
