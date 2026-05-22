import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "approval_request",
    label: "Optional Approval Request",
    description:
      "Optional human confirmation for user-selected checkpoints. Feishu actions are not intercepted here; official lark-cli operations run through feishu_cli.",
    parameters: Type.Object({
      action: Type.String({ description: "Action or checkpoint name." }),
      target: Type.String({ description: "Target object, user, chat, doc, or local artifact." }),
      summary: Type.String({ description: "Short summary of the proposed action." }),
      risk: Type.Optional(Type.String({ description: "Potential risk if this action is approved." })),
      riskLevel: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      ),
      visibility: Type.Optional(Type.String({ description: "Audience or visibility scope." })),
      notify: Type.Optional(Type.Boolean({ description: "Whether people will be notified." })),
      reversible: Type.Optional(Type.Boolean({ description: "Whether the action can be cleanly reverted." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const message = [
        `Action: ${params.action}`,
        `Target: ${params.target}`,
        `Summary: ${params.summary}`,
        `Risk level: ${params.riskLevel ?? "not specified"}`,
        `Visibility: ${params.visibility ?? "not specified"}`,
        `Notify: ${params.notify === true ? "yes" : "no or unknown"}`,
        `Risk: ${params.risk ?? "not specified"}`,
        `Reversible: ${params.reversible === true ? "yes" : "no or unknown"}`,
      ].join("\n");

      if (!ctx.hasUI) {
        const requestedAt = new Date().toISOString();
        return {
          content: [{ type: "text", text: `Approval blocked: no interactive UI is available.\n${message}` }],
          details: {
            status: "blocked",
            decision: "unavailable",
            approved: false,
            approvalRequired: true,
            approvalRequested: true,
            approvalAvailable: false,
            canProceed: false,
            action: params.action,
            target: params.target,
            requestedAt,
            reason: "No interactive UI is available for this requested confirmation.",
          },
        };
      }

      const approved = await ctx.ui.confirm("Approve optional checkpoint?", message);
      const decision = approved ? "approved" : "rejected";
      return {
        content: [{ type: "text", text: approved ? "Approved by user." : "Rejected by user." }],
        details: {
          status: decision,
          decision,
          approved,
          approvalRequired: true,
          approvalRequested: true,
          approvalAvailable: true,
          canProceed: approved,
          action: params.action,
          target: params.target,
          decidedAt: new Date().toISOString(),
        },
      };
    },
  });
}
