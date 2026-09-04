// src/parse/blueprint.ts — blueprints/*.blueprint.yaml → Blueprint IR
//
// Phase term-P4.5：载体从 MD 转 YAML。
//   Blueprint 是纯结构化无叙事（target + mode + modules），MD 的 H2/H3 是用叙事格式装非叙事数据。
//   YAML 直接表达嵌套结构，parser 简化为 yaml.load() + 校验，与 frontmatter 同构。
//
// Blueprint asset 格式（v9.5）：
//   name: <blueprint-name>
//   injectionPoints:
//     - name: 会话知识              ← 注入点（人类自定义语义名）
//       target: session              ← 注入位置（session / turn，Agent-agnostic）
//       mode: hybrid                 ← 可选
//       modules: [Scene, Trigger]    ← 聚合点（Domain H2 段名列表）
//     - name: 参考手册
//       target: turn
//       modules: [Manual]
//
// Tech Debt T6: 用 constants + type guard（pt-quality #1/#4/#5）

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  Blueprint,
  InjectionPointConfig,
  InjectionTarget,
  StructureLayout,
} from "../schema.js";

const VALID_MODES: ReadonlyArray<StructureLayout["mode"]> = ["byDomain", "byType", "hybrid"];

interface RawInjectionPoint {
  name: string;
  target: string;
  mode?: string;
  modules: string[];
}

interface RawBlueprint {
  name: string;
  injectionPoints: RawInjectionPoint[];
}

/** 读 blueprints/<fileName>.blueprint.yaml → Blueprint { name, injectionPoints } */
export async function parseBlueprint(absDir: string, fileName: string): Promise<Blueprint> {
  const filePath = join(absDir, fileName);
  const raw = await readFile(filePath, "utf8");
  const data = parseYaml(raw) as RawBlueprint;

  if (!data || typeof data.name !== "string") {
    throw new Error(`parseBlueprint: ${fileName} 缺少顶层 name 字段`);
  }
  if (!Array.isArray(data.injectionPoints)) {
    throw new Error(`parseBlueprint: ${fileName} 缺少 injectionPoints 数组`);
  }

  const injectionPoints: InjectionPointConfig[] = data.injectionPoints.map((ip) => {
    if (typeof ip.name !== "string") {
      throw new Error(`parseBlueprint: ${fileName} 注入点缺 name 字段`);
    }
    if (typeof ip.target !== "string") {
      throw new Error(`parseBlueprint: ${fileName} 注入点 ${ip.name} 缺 target 字段`);
    }
    if (!Array.isArray(ip.modules)) {
      throw new Error(`parseBlueprint: ${fileName} 注入点 ${ip.name} 缺 modules 数组`);
    }

    const config: InjectionPointConfig = {
      name: ip.name,
      target: ip.target as InjectionTarget,
      modules: ip.modules.map((m) => String(m)),
    };
    if (ip.mode && isValidMode(ip.mode)) {
      config.mode = ip.mode;
    }
    return config;
  });

  return { name: data.name, injectionPoints };
}

function isValidMode(x: string): x is StructureLayout["mode"] {
  return (VALID_MODES as readonly string[]).includes(x);
}
