import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";

type TodoItem = {
  itemId: string;
  kind: string;
  label: string;
  description?: string;
  status: string;
  priority?: string;
  interactive?: boolean;
  options?: string[];
};

type Projection = {
  planId?: string | null;
  revision?: number;
  completed?: number;
  total?: number;
  awaitingUser?: boolean;
  items?: TodoItem[];
};

export default function executionTodoUi(pi: ExtensionAPI): void {
  let projection: Projection | null = null;

  function optionLabel(option: string) {
    return ({
      "prd": "生成 PRD",
      "customer-requirement-checklist": "生成客户需求确认表",
      "tech-architecture": "生成技术架构",
      "ops-plan": "生成运营方案",
      "review-customer-questions": "先审阅客户问题",
      "keep-meeting-minutes-only": "仅保留会议纪要",
    } as Record<string, string>)[option] ?? option;
  }

  function discoverLedger(ctx: ExtensionContext) {
    const candidates = [
      join(ctx.cwd, "planner-envelope.json"),
      join(ctx.cwd, "runtime-runs", "planner-envelope.json"),
    ];
    for (const root of [join(ctx.cwd, "runtime-runs", "feishu-agent", "runs"), join(ctx.cwd, "runtime-runs")]) {
      if (!existsSync(root)) continue;
      try {
        const recent = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(root, entry.name, "planner-envelope.json"))
          .filter((path) => existsSync(path))
          .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
          .slice(0, 20);
        candidates.push(...recent);
      } catch {
        // A missing or concurrently changing runtime directory is non-fatal UI state.
      }
    }
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const ledger = JSON.parse(readFileSync(path, "utf8"));
        if (ledger?.userTodoProjection) return ledger.userTodoProjection as Projection;
      } catch {
        // Keep the last valid projection; UI failure must not affect task execution.
      }
    }
    return null;
  }

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI || !projection?.items?.length) {
      ctx.ui.setWidget("office-execution-todo", undefined);
      ctx.ui.setStatus("office-execution-todo", undefined);
      return;
    }
    const items = projection.items;
    const unfinished = items.filter((item) => !["completed", "answered", "dismissed", "skipped", "cancelled"].includes(item.status));
    const lines = [
      ctx.ui.theme.fg("accent", `Office Agent · ${projection.completed ?? 0}/${projection.total ?? 0}${projection.awaitingUser ? " · 等待选择" : ""}`),
      ...unfinished.slice(0, 6).map((item) => {
        const mark = item.interactive ? "?" : item.status === "in_progress" ? "●" : item.status === "blocked" ? "!" : "○";
        return `${ctx.ui.theme.fg(item.interactive ? "warning" : "muted", mark)} ${item.label}`;
      }),
      ...(unfinished.length > 6 ? [ctx.ui.theme.fg("dim", `+${unfinished.length - 6} more · /todos 查看全部`)] : []),
    ];
    ctx.ui.setWidget("office-execution-todo", lines);
    ctx.ui.setStatus("office-execution-todo", ctx.ui.theme.fg("accent", `☑ ${projection.completed ?? 0}/${projection.total ?? 0}`));
  }

  function refresh(ctx: ExtensionContext) {
    projection = discoverLedger(ctx) ?? projection;
    render(ctx);
  }

  pi.on("session_start", async (_event, ctx) => refresh(ctx));
  pi.on("turn_end", async (_event, ctx) => refresh(ctx));

  pi.registerTool({
    name: "execution_todo_present",
    label: "Execution Todo Present",
    description: "Present an Execution Ledger Todo projection in the Pi widget without creating a second task state.",
    parameters: Type.Object({ projection: Type.Any() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      projection = params.projection as Projection;
      render(ctx);
      const details = { status: "presented", projection, rawSecretsReturned: false };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerCommand("todos", {
    description: "Show the current execution ledger, open questions and next-step choices",
    handler: async (args, ctx) => {
      const explicit = args.trim();
      if (explicit) {
        const path = resolve(ctx.cwd, explicit);
        if (!existsSync(path)) {
          ctx.ui.notify(`Ledger not found: ${explicit}`, "warning");
          return;
        }
        try {
          const ledger = JSON.parse(readFileSync(path, "utf8"));
          projection = ledger?.userTodoProjection ?? null;
        } catch {
          ctx.ui.notify("Ledger JSON is invalid.", "error");
          return;
        }
      } else {
        projection = discoverLedger(ctx) ?? projection;
      }
      if (!projection?.items?.length) {
        ctx.ui.notify("当前没有可显示的 Execution Ledger。可使用 /todos <planner-envelope.json 路径>。", "info");
        return;
      }
      render(ctx);
      const interactive = projection.items.filter((item) => item.interactive && item.status === "pending");
      if (interactive.length === 0 || !ctx.hasUI) {
        const text = projection.items.map((item) => `${item.status === "completed" ? "✓" : item.interactive ? "?" : "○"} ${item.label}`).join("\n");
        ctx.ui.notify(text, "info");
        return;
      }
      const labels = interactive.map((item) => item.options?.length ? `${item.label}（${item.options.map(optionLabel).join(" / ")}）` : item.label);
      const interactiveLabelCount = labels.length;
      labels.push("补充或重排我自己的下一步");
      const selected = await ctx.ui.select("Office Agent：请选择下一步", labels);
      if (!selected) return;
      if (selected === "补充或重排我自己的下一步") {
        const custom = await ctx.ui.editor("请输入你的下一步、优先级或调整：", "");
        if (custom?.trim()) pi.sendUserMessage(`请根据当前 Execution Ledger 调整下一步：${custom.trim()}`);
        return;
      }
      const selectedIndex = labels.indexOf(selected);
      const item = selectedIndex >= 0 && selectedIndex < interactiveLabelCount ? interactive[selectedIndex] : null;
      if (!item) return;
      if (item.options?.length) {
        const optionLabels = item.options.map(optionLabel);
        const option = await ctx.ui.select(item.label, [...optionLabels, "我自己补充"]);
        if (!option) return;
        if (option === "我自己补充") {
          const custom = await ctx.ui.editor("请输入你的选择：", "");
          if (custom?.trim()) pi.sendUserMessage(`关于“${item.label}”，我的选择是：${custom.trim()}`);
        } else {
          const optionIndex = optionLabels.indexOf(option);
          pi.sendUserMessage(`关于“${item.label}”，我选择：${optionIndex >= 0 ? item.options[optionIndex] : option}`);
        }
      } else {
        const answer = await ctx.ui.editor(`请回答：${item.label}`, "");
        if (answer?.trim()) pi.sendUserMessage(`回答 Todo「${item.itemId}｜${item.label}」：${answer.trim()}`);
      }
    },
  });
}
