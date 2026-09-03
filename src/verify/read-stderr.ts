// src/verify/read-stderr.ts — execSync 异常 stderr 提取公共辅助（P3.5 抽出）
//
// execSync 抛异常时 stderr 是 Uint8Array，需要 Buffer.from 转换。
// lint-check.ts + test-pass.ts 都需要此逻辑——抽到此处避免重复。

/** execSync 抛出的异常可能包含的 stderr 字段（Node 内部行为）。 */
type ExecError = Error & { stderr?: Uint8Array | string };

/** 从 execSync 抛出的异常中提取 stderr 字符串。
 *  - e 非 Error 或无 stderr 字段 → 返 ""
 *  - stderr 为 Uint8Array → Buffer 转字符串
 *  - 其他类型 → String() 兜底 */
export function readStderr(e: unknown): string {
  if (e instanceof Error && "stderr" in e) {
    const stderr = (e as ExecError).stderr;
    if (stderr instanceof Uint8Array) {
      return Buffer.from(stderr).toString();
    }
    if (typeof stderr === "string") {
      return stderr;
    }
  }
  return "";
}
