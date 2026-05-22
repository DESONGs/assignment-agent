import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const supportedExts = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".mp4",
  ".mov",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
]);

function hashFile(path: string) {
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", rejectHash);
    stream.on("end", () => {
      resolveHash(hash.digest("hex"));
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "rokid_import_exported_assets",
    label: "Import Rokid Exported Assets",
    description:
      "Index media files from a Rokid/Lingzhu export directory. Does not upload or call external services.",
    parameters: Type.Object({
      directory: Type.String({ description: "Local Rokid export directory." }),
      deviceLabel: Type.Optional(Type.String({ description: "Device or source label." })),
      privacy: Type.Optional(
        Type.Union([
          Type.Literal("private"),
          Type.Literal("internal"),
          Type.Literal("customer-confidential"),
        ]),
      ),
    }),
    async execute(_toolCallId, params) {
      const root = resolve(params.directory);
      const files = await Promise.all(readdirSync(root)
        .filter((name) => supportedExts.has(extname(name).toLowerCase()))
        .map(async (name) => {
          const path = join(root, name);
          const stat = statSync(path);
          return {
            source: "rokid-lingzhu-export",
            deviceLabel: params.deviceLabel ?? "rokid",
            path,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            hashSha256: await hashFile(path),
            privacy: params.privacy ?? "private",
          };
        }));

      return {
        content: [{ type: "text", text: JSON.stringify({ assets: files }, null, 2) }],
        details: { assets: files },
      };
    },
  });

  pi.registerTool({
    name: "rokid_lingzhu_mcp_plan",
    label: "Rokid Lingzhu MCP Plan",
    description:
      "Create a structured plan for invoking Rokid Lingzhu MCP capabilities without implementing a custom bridge.",
    parameters: Type.Object({
      capability: Type.String({ description: "Lingzhu MCP capability or official workflow name." }),
      purpose: Type.String({ description: "Why the meeting agent needs this capability." }),
      expectedAssets: Type.Array(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const plan = {
        provider: "rokid-lingzhu",
        bridgeType: "official-mcp-or-platform-workflow",
        customBridgeRequired: false,
        capability: params.capability,
        purpose: params.purpose,
        expectedAssets: params.expectedAssets,
        security: {
          preservePlatformAuth: true,
          noRawUploadWithoutApproval: true,
          normalizeMetadataBeforeProcessing: true,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
        details: plan,
      };
    },
  });
}
