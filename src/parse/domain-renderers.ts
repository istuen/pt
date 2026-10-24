// src/parse/domain-renderers.ts — Domain H2 段解析注册表（pt-quality #3）
//
// Phase term-P9.3：注册表从二维（h2Name × type）降为一维（h2Name）。
//   - Type 字段已删除——H2 段名 = schema 选择器（一个 H2 段一个 schema）
//   - 加新 H2 段名 = 调 registerDomainSectionRenderer 加一行 + parser 函数
//
// 替换 parse/domain.ts 中的 switch-case 主逻辑。switch-case 仅留兜底 default fallback。

import { s, sArr, type Item } from "./shared.js";
import type { Checklist, ExternalRef, FlowStep, NormCheck, Rule } from "../schema.js";

/** 单个 H2 段内容解析器。 */
export type DomainSectionParser = (items: Item[], sectionRaw: string) => unknown;

/** 各段解析器消费的字段名（白名单）——不在白名单里的字段会被静默丢弃。
 *  v19（A1）：据此收集 unknownFields 交体检告警（写错的字段静默失效 = 假合规）。 */
const SECTION_KNOWN_FIELDS: Record<string, ReadonlySet<string>> = {
  Scene: new Set(["desc", "description", "role", "path", "fields", "purpose", "rule"]),
  Trigger: new Set(["desc", "description", "hint", "anti"]),
  Rules: new Set(["check", "items", "slot", "type", "observe", "checks"]),
  Checklists: new Set(["items", "check", "step", "rationale", "observe", "checks"]),
};

/** 取该项里不被本段消费的字段名。 */
function unknownFieldsOf(section: string, it: Item): string[] {
  const known = SECTION_KNOWN_FIELDS[section];
  if (!known) return [];
  return Object.keys(it.fields ?? {}).filter((k) => !known.has(k));
}

/** 宽松解析检查绑定（issue pt-asset-verifiable-norm A1）。
 *  接受三种写法（坏数据丢弃，不抛）：
 *   - 对象 `{ probe: X, params: { k: v }, on: notify }` → 单个
 *   - 数组 → 逐项（元素是对象/字符串才收）
 *   - 字符串 → 视作 `{ probe: <str> }`（等价 observe 单值）
 */
export function parseNormChecks(v: unknown): NormCheck[] {
  const out: NormCheck[] = [];
  const one = (raw: unknown): void => {
    if (typeof raw === "string") {
      const probe = raw.trim();
      if (probe) out.push({ probe });
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    const probe = typeof o.probe === "string" ? o.probe.trim() : "";
    if (!probe) return;
    const check: NormCheck = { probe };
    if (o.params && typeof o.params === "object") {
      const params: Record<string, string> = {};
      for (const [k, pv] of Object.entries(o.params as Record<string, unknown>)) {
        if (typeof pv === "string") params[k] = pv;
        else if (typeof pv === "number" || typeof pv === "boolean") params[k] = String(pv);
      }
      if (Object.keys(params).length > 0) check.params = params;
    }
    if (o.on === "block" || o.on === "notify") check.on = o.on;
    out.push(check);
  };
  if (Array.isArray(v)) {
    for (const item of v) one(item);
  } else if (v !== undefined && v !== null && v !== "") {
    one(v);
  }
  return out;
}

/** 注册表：H2段名 → parser。Phase term-P9.3：删 type 维度。 */
const domainSectionRenderers: Record<string, DomainSectionParser> = {
  // H2="Scene"（Phase term-P9.1：统一为 Term[]）
  Scene: (items) =>
    items.map((it) => {
      const desc = s(it.fields.desc) || s(it.fields.description) || s(it.fields.role) || "";
      const path = s(it.fields.path);
      const fields = sArr(it.fields.fields);
      const note = s(it.fields.purpose) || s(it.fields.rule);
      const term: {
        name: string;
        desc?: string;
        fields?: string[];
        note?: string;
        path?: string;
        unknownFields?: string[];
      } = {
        name: it.name,
      };
      if (desc) term.desc = desc;
      if (path) term.path = path;
      if (fields.length > 0) term.fields = fields;
      const unknown = unknownFieldsOf("Scene", it);
      if (unknown.length > 0) term.unknownFields = unknown;
      if (note) term.note = note;
      return term;
    }),
  // H2="Trigger"（pt-trigger-hint-field-loss 修复 + pt-trigger-anti-field-phase-b）—— TriggerItem[]
  //   parse 层输出 { name, desc?, hint?, anti? }，与 render 层 renderTriggerModule + type guard 对齐。
  //   - hint：正向补充说明（调哪个 manual / tool）
  //   - anti：负向触发条件（什么情况不触发），减少误触发注入
  //   原走 fallbackTerms 只输出 { name, desc }，hint/anti 丢弃——本 parser 修复。
  Trigger: (items) =>
    items.map((it) => {
      const desc = s(it.fields.desc) || s(it.fields.description) || "";
      const hint = s(it.fields.hint);
      const anti = s(it.fields.anti);
      const trigger: {
        name: string;
        desc?: string;
        hint?: string;
        anti?: string;
        unknownFields?: string[];
      } = {
        name: it.name,
      };
      if (desc) trigger.desc = desc;
      if (hint) trigger.hint = hint;
      if (anti) trigger.anti = anti;
      const unknown = unknownFieldsOf("Trigger", it);
      if (unknown.length > 0) trigger.unknownFields = unknown;
      return trigger;
    }),
  // H2="Rules"（Phase term-P9.2：从 Manual.term 拆出）—— Rule[]
  Rules: (items) =>
    items.map((it) => {
      const itemsArr = sArr(it.fields.items);
      const check =
        s(it.fields.check) ||
        s(it.fields.desc) ||
        s(it.fields.value) ||
        s(it.fields.description) ||
        "";
      // v19（A1）：可自动验证的探针绑定——observe（无参形态）/ checks（带参结构化）
      const observe = sArr(it.fields.observe);
      const checks = parseNormChecks(it.fields.checks);
      const unknown = unknownFieldsOf("Rules", it);
      const rule: Rule = {
        name: it.name,
        slot: "global",
        type: itemsArr.length > 0 ? "ban" : "invariant",
        check,
      };
      if (itemsArr.length > 0) rule.items = itemsArr;
      if (observe.length > 0) rule.observe = observe;
      if (checks.length > 0) rule.checks = checks;
      if (unknown.length > 0) rule.unknownFields = unknown;
      return rule;
    }),
  // H2="Flows"（Phase term-P9.2：从 Manual.workflow 拆出）—— FlowTemplate[]
  Flows: (items, sectionRaw) =>
    items.map((item) => {
      const tpl: Record<string, unknown> = {
        name: item.name,
        argumentHint: s(item.fields["argument-hint"]) || undefined,
        intent: s(item.fields.intent),
        steps: collectSteps(item.name, sectionRaw),
      };
      const vars = sArr(item.fields.vars);
      if (vars.length > 0) tpl._vars = vars;
      return tpl;
    }),
  // H2="Checklists"（Phase term-P9.2：新增）—— Checklist[]
  Checklists: (items) =>
    items.map((it) => {
      const observe = sArr(it.fields.observe);
      const checks = parseNormChecks(it.fields.checks);
      const unknown = unknownFieldsOf("Checklists", it);
      const checklist: Checklist = { name: it.name, items: sArr(it.fields.items) };
      if (observe.length > 0) checklist.observe = observe;
      if (checks.length > 0) checklist.checks = checks;
      if (unknown.length > 0) checklist.unknownFields = unknown;
      return checklist;
    }),
};

/** 加新 H2 段名 = 调 registerDomainSectionRenderer 加一行注册 + 一个 parser 函数。
 *  Phase term-P9.3：删 type 参数。 */
export function registerDomainSectionRenderer(h2Name: string, parser: DomainSectionParser): void {
  domainSectionRenderers[h2Name] = parser;
}

/** 取 H2段名 的 parser。未注册返 undefined（调用方走 fallback）。Phase term-P9.3：删 type 参数。 */
export function getDomainSectionParser(h2Name: string): DomainSectionParser | undefined {
  return domainSectionRenderers[h2Name];
}

// ==================== shared 辅助 ====================

function collectSteps(itemName: string, sectionRaw: string): FlowStep[] {
  const lines = sectionRaw.split(/\r?\n/);
  const steps: FlowStep[] = [];
  let inItem = false;
  let cur: FlowStep | null = null;
  // P2 状态机：累积 dataSource 块（块式 YAML 形态）。非 null 时进入子字段收集模式。
  let dsBuffer: Partial<ExternalRef> | null = null;
  // dataSource 起始行的缩进，用于判定子行是否仍在块内。
  let dsBaseIndent = 0;

  const flushDataSource = () => {
    if (dsBuffer && cur) {
      // 仅当必填字段齐了才落 ExternalRef，避免输出空对象
      if (dsBuffer.name && dsBuffer.path) {
        cur.dataSource = dsBuffer as ExternalRef;
      }
    }
    dsBuffer = null;
  };

  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      flushDataSource();
      if (inItem) break;
      if (h3[1]?.trim() === itemName) inItem = true;
      continue;
    }
    if (!inItem) continue;

    // dataSource 子字段累积阶段：缩进 > dsBaseIndent 的 `key: value` 行入块。
    if (dsBuffer) {
      const sub = line.match(/^(\s+)([a-zA-Z_][\w-]*)\s*:\s*(.+)$/);
      if (sub?.[1] && sub[2] && sub[3] && sub[1].length > dsBaseIndent) {
        const key = sub[2];
        const val = sub[3].trim();
        // 只认 ExternalRef 已知字段，避免灌入垃圾字段（如 "extra: x"）
        if (key === "name" || key === "path" || key === "desc") {
          (dsBuffer as Record<string, string>)[key] = val;
        } else if (key === "protocol") {
          // protocol 是字面量联合（"api" | "db" | "file"），未知值丢弃——避免下游 string 错配
          if (val === "api" || val === "db" || val === "file") {
            dsBuffer.protocol = val;
          }
        }
        continue;
      }
      // 块结束：flush，回到正常分支让当前行重判。
      flushDataSource();
    }

    const stepMatch = line.match(/^\s*-\s+step\s*:\s*(.+)$/);
    if (stepMatch) {
      flushDataSource();
      if (cur) steps.push(cur);
      cur = { desc: stepMatch[1]?.trim() ?? "" };
      continue;
    }

    // P2：dataSource 块起始（空冒号，紧随缩进的子字段）
    const dsStart = line.match(/^\s*-\s+dataSource\s*:\s*$/);
    if (dsStart && cur) {
      dsBaseIndent = (line.match(/^(\s*)/)?.[1] ?? "").length;
      dsBuffer = {};
      continue;
    }

    // P2：output 行内值（单行文本，不支持块式——output 是简短产出说明）
    const outputMatch = line.match(/^\s*-\s+output\s*:\s*(.+)$/);
    if (outputMatch && cur) {
      cur.output = outputMatch[1]?.trim();
      continue;
    }

    const observeMatch = line.match(/^\s*-\s+observe\s*:\s*(.+)$/);
    if (observeMatch && cur) {
      const val = observeMatch[1]?.trim() ?? "";
      const arrMatch = val.match(/^\[(.*)\]$/);
      if (arrMatch) {
        cur.observe = arrMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
      } else {
        cur.observe = [val];
      }
    }
  }
  flushDataSource();
  if (cur) steps.push(cur);
  return steps;
}
