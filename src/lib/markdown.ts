/**
 * 极简 Markdown 渲染器（零第三方依赖）。
 *
 * 设计要点：
 * 1. **先转义后渲染**——源文本先做 HTML 转义，再由本模块自己拼出有限标签，
 *    因此模型输出里的 <script> 之类不会被当成真实标签执行，天然免疫 XSS；
 * 2. 兼容流式：代码块没写完（缺收尾 ```）时也能正常渲染，不会出现源码闪现；
 * 3. 覆盖助手回答常用语法：标题、粗体/斜体/删除线、行内代码、围栏代码块、
 *    有序/无序列表、引用、表格、分隔线、链接（仅放行 http/https/mailto 与站内链接）。
 */

const 转义表: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function 转义(文本: string): string {
  return 文本.replace(/[&<>"']/g, (字符) => 转义表[字符] ?? 字符);
}

/** 只放行安全协议，挡掉 javascript: / data: 等可利用链接 */
function 安全链接(地址: string): string | null {
  const 值 = 地址.trim();
  if (/^(https?:\/\/|mailto:|#|\/)/i.test(值)) return 值;
  return null;
}

/** 行内语法一次扫描成型：靠前的分支优先，避免占位符带来的复杂度 */
const 行内模式 =
  /`([^`\n]+)`|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*\n]+)\*|~~([^~]+)~~|\[([^\]]*)\]\(([^)\s]+)\)/g;

function 行内(文本: string): string {
  return 文本.replace(
    行内模式,
    (原文, 代码, 粗斜, 粗体, 斜体, 删除线, 链接文字, 链接地址) => {
      if (代码 !== undefined) return `<code>${代码}</code>`;
      if (粗斜 !== undefined) return `<strong><em>${粗斜}</em></strong>`;
      if (粗体 !== undefined) return `<strong>${粗体}</strong>`;
      if (斜体 !== undefined) return `<em>${斜体}</em>`;
      if (删除线 !== undefined) return `<del>${删除线}</del>`;
      if (链接地址 !== undefined) {
        const 安全 = 安全链接(链接地址);
        if (安全 === null) return 原文;
        // 地址此时已经过转义，站内相对链接不加 target，外链才新窗口打开
        const 目标 = /^https?:\/\//i.test(安全) ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a href="${安全}"${目标}>${链接文字}</a>`;
      }
      return 原文;
    },
  );
}

const 围栏模式 = /^(?:```|~~~)\s*(\S*)/;
const 收尾围栏模式 = /^(?:```|~~~)\s*$/;
const 标题模式 = /^(#{1,6})\s+(.*)$/;
const 分隔线模式 = /^(-{3,}|\*{3,}|_{3,})$/;
const 引用模式 = /^>\s?/;
const 无序模式 = /^[-*+]\s+(.*)$/;
const 有序模式 = /^(\d+)[.)]\s+(.*)$/;
const 表格分隔模式 = /^\|?[\s:|-]*-[\s:|-]*\|?$/;

function 渲染行组(行组: string[]): string {
  const 输出: string[] = [];
  let 段落: string[] = [];
  let 索引 = 0;

  const 收段落 = (): void => {
    if (段落.length === 0) return;
    输出.push(`<p>${行内(转义(段落.join("\n"))).replace(/\n/g, "<br>")}</p>`);
    段落 = [];
  };

  const 拆表格单元格 = (行: string): string[] =>
    行
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((单元) => 单元.trim());

  while (索引 < 行组.length) {
    const 原文 = 行组[索引];
    const 去空 = 原文.trim();

    if (去空 === "") {
      收段落();
      索引 += 1;
      continue;
    }

    // 围栏代码块：即使流式途中还没出现收尾围栏，也能把已到达的部分装进 <pre>
    const 围栏 = 围栏模式.exec(去空);
    if (围栏) {
      收段落();
      const 语言 = 围栏[1] ?? "";
      const 代码行: string[] = [];
      索引 += 1;
      while (索引 < 行组.length && !收尾围栏模式.test(行组[索引].trim())) {
        代码行.push(行组[索引]);
        索引 += 1;
      }
      索引 += 1; // 跳过收尾围栏（若已到达）
      const 类名 = 语言 ? ` class="md-code md-lang-${转义(语言)}"` : ' class="md-code"';
      输出.push(`<pre${类名}><code>${转义(代码行.join("\n"))}</code></pre>`);
      continue;
    }

    const 标题 = 标题模式.exec(去空);
    if (标题) {
      收段落();
      const 级 = (标题[1] ?? "#").length;
      输出.push(`<h${级}>${行内(转义(标题[2] ?? ""))}</h${级}>`);
      索引 += 1;
      continue;
    }

    if (分隔线模式.test(去空)) {
      收段落();
      输出.push("<hr>");
      索引 += 1;
      continue;
    }

    if (引用模式.test(去空)) {
      收段落();
      const 引用行: string[] = [];
      while (索引 < 行组.length && 引用模式.test(行组[索引].trim())) {
        引用行.push(行组[索引].trim().replace(引用模式, ""));
        索引 += 1;
      }
      输出.push(`<blockquote>${渲染行组(引用行)}</blockquote>`);
      continue;
    }

    // 表格：当前行含 |，且下一行是 |---|---| 形式的分隔行
    const 下一行 = 索引 + 1 < 行组.length ? 行组[索引 + 1].trim() : "";
    if (去空.includes("|") && 下一行 !== "" && 表格分隔模式.test(下一行) && 下一行.includes("-")) {
      收段落();
      const 表头 = 拆表格单元格(去空);
      索引 += 2;
      const 表体: string[][] = [];
      while (索引 < 行组.length && 行组[索引].trim() !== "" && 行组[索引].includes("|")) {
        表体.push(拆表格单元格(行组[索引]));
        索引 += 1;
      }
      const 头行 = 表头.map((单元) => `<th>${行内(转义(单元))}</th>`).join("");
      const 体行 = 表体
        .map(
          (单元组) =>
            `<tr>${单元组.map((单元) => `<td>${行内(转义(单元))}</td>`).join("")}</tr>`,
        )
        .join("");
      输出.push(
        `<table class="md-table"><thead><tr>${头行}</tr></thead><tbody>${体行}</tbody></table>`,
      );
      continue;
    }

    if (无序模式.test(去空) || 有序模式.test(去空)) {
      收段落();
      const 有序 = 有序模式.test(去空);
      const 模式 = 有序 ? 有序模式 : 无序模式;
      const 表项: string[] = [];
      while (索引 < 行组.length) {
        const 当前原文 = 行组[索引];
        const 匹配 = 模式.exec(当前原文.trim());
        if (匹配) {
          表项.push(有序 ? (匹配[2] ?? "") : (匹配[1] ?? ""));
          索引 += 1;
          continue;
        }
        // 缩进续行并入上一项
        if (/^\s+\S/.test(当前原文) && 表项.length > 0) {
          const 末项 = 表项[表项.length - 1] ?? "";
          表项[表项.length - 1] = `${末项}\n${当前原文.trim()}`;
          索引 += 1;
          continue;
        }
        break;
      }
      const 标签 = 有序 ? "ol" : "ul";
      const 项节点 = 表项
        .map((项) => {
          const 行集 = 项.split("\n");
          return `<li>${行集.length > 1 ? 渲染行组(行集) : 行内(转义(项))}</li>`;
        })
        .join("");
      输出.push(`<${标签}>${项节点}</${标签}>`);
      continue;
    }

    段落.push(去空);
    索引 += 1;
  }

  收段落();
  return 输出.join("\n");
}

/** 把 Markdown 源文本渲染为可直接 innerHTML 注入的 HTML（已做转义，安全） */
export function 渲染Markdown(源文本: string): string {
  if (!源文本) return "";
  return 渲染行组(源文本.replace(/\r\n?/g, "\n").split("\n"));
}
