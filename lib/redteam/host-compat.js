/**
 * 宿主 schema 漂移守卫（红队预设专用）。
 *
 * 2.0.23-next 起 `@deepseek-ai/dsh-tool-subagent` 的 apply() 对两个 config 键直接抛错：
 *
 *   for (const field of ["persona", "toolFilter"]) if (Object.hasOwn(config, field))
 *     throw new Error(`tool-subagent: ${field} is no longer supported; ...`)
 *
 * 预设是按 group 整体交给 registry 的：一行抛错 → 整个 delegation group 挂不上 →
 * `list-agents` 一直 never started → 面板显示「红队模式 / 加载失败」，
 * `$DSH_HOME/redteam/preset-declare.json` 记 `registered-broken`。
 *
 * 另外两个键（modelSelectionSettings / backgroundMode）在新版 schema 里已经不存在，
 * Schemastery 非严格模式会静默忽略 —— 更糟：行挂上了，行为没了，也没人报错。
 *
 * 两层守卫同源：
 *   - repairPresetText()          改写磁盘上的旧预设文本（跟 installPreset 其它自愈步骤一样），
 *                                 重启后旧文本不会再回来咬人；
 *   - sanitizePresetDefinition()  在解析后的声明上再摘一次，手工改过、或走到随包模板的分支
 *                                 也能挂上。
 * 两个函数共用 HOST_FIELD_RULES，新增/删除失效键只改一处。
 */

/**
 * 宿主已不再接受的 config 键。
 * - drop: true        直接删除；
 * - upgrade: true     旧键的语义在新版里叫 modelSelection/modelDiscovery，值仍为 true 时补上。
 * 注意 fork 行故意不配 model selection（保 KV cache），upgrade 会跳过它。
 */
const HOST_FIELD_RULES = Object.freeze([
  Object.freeze({ field: "persona", drop: true }),
  Object.freeze({ field: "toolFilter", drop: true }),
  Object.freeze({ field: "backgroundMode", drop: true }),
  Object.freeze({ field: "modelSelectionSettings", drop: true, upgrade: true }),
]);

const ROW_ID_RE = /^\s*-\s+id:\s*(\S+)\s*$/;
const KEY_RE = /^(\s*)([A-Za-z_][\w-]*)\s*:(\s*)(.*)$/;

function leadingSpaces(line) {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

function unquote(value) {
  return String(value || "").replace(/^["']|["']$/g, "");
}

/**
 * 从预设文本里摘掉宿主已拒绝的 config 键。
 * @param text - `agent.cordis.yml` 的原始文本。
 * @returns `{ text, changed, fields }`，fields 是本轮摘掉的键名，便于写进自愈日志。
 */
export function repairPresetText(text) {
  const source = String(text ?? "");
  if (!source || !source.includes(":")) return { text: source, changed: false, fields: [] };

  const lines = source.split("\n");
  const out = [];
  const fields = new Set();
  let currentId = "";
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const rowMatch = ROW_ID_RE.exec(line);
    if (rowMatch) currentId = unquote(rowMatch[1]);

    const keyMatch = KEY_RE.exec(line);
    if (!keyMatch) {
      out.push(line);
      continue;
    }
    const [, indent, key, gap, inlineValue] = keyMatch;
    const rule = HOST_FIELD_RULES.find((item) => item.field === key);
    if (!rule) {
      out.push(line);
      continue;
    }

    // 值换行时（toolFilter: 下面挂 - deny: …）整块一起摘，别留孤儿缩进。
    let end = index + 1;
    if (!inlineValue.trim()) {
      const base = leadingSpaces(line);
      while (end < lines.length) {
        const candidate = lines[end];
        if (!candidate.trim()) {
          end += 1;
          continue;
        }
        if (leadingSpaces(candidate) <= base) break;
        end += 1;
      }
      // 块尾的空行不属于这个键，留给文件保持原有空行节奏
      while (end > index + 1 && !lines[end - 1].trim()) end -= 1;
    }

    changed = true;
    fields.add(key);
    const isForkRow = currentId.toLowerCase().includes("fork");
    if (rule.upgrade && !isForkRow && inlineValue.trim().toLowerCase() === "true") {
      out.push(`${indent}modelSelection:${gap || " "}true`);
      out.push(`${indent}modelDiscovery:${gap || " "}true`);
    }
    index = end - 1;
  }

  return { text: out.join("\n"), changed, fields: [...fields] };
}

/**
 * 在解析后的预设声明上再摘一次失效键（穿透 group 行）。
 * @returns `{ definition, stripped }`，stripped 形如 `tool-subagent:toolFilter`。
 */
export function sanitizePresetDefinition(definition) {
  const stripped = [];
  const visit = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (Array.isArray(row.config)) {
        visit(row.config);
        continue;
      }
      if (row.group === true) continue;
      const config = row.config;
      if (!config || typeof config !== "object") continue;
      for (const rule of HOST_FIELD_RULES) {
        if (!Object.hasOwn(config, rule.field)) continue;
        delete config[rule.field];
        stripped.push(`${row.id || row.name || "row"}:${rule.field}`);
      }
    }
  };
  visit(definition ? definition.plugins : undefined);
  return { definition, stripped };
}

export { HOST_FIELD_RULES };