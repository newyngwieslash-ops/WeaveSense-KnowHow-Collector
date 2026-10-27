import type { Engine } from "./engine.ts";
import type { ExecutionContext } from "./auth.ts";
import { VideoKnowledgeService } from "./video-knowledge.ts";
import { VideoKnowledgeSkills } from "./video-knowledge-skills.ts";
import { VideoKnowledgeExtractor } from "./video-knowledge-extractor.ts";
import { assertKnowledgeEnabled } from "./video-knowledge-runtime.ts";
import { VideoOriginCandidates } from "./video-origin-candidates.ts";
import { VideoRetentionImpact } from "./video-retention-impact.ts";

export function videoKnowledgeRoutes(engine: Engine) {
  const knowledge = new VideoKnowledgeService(engine), skills = new VideoKnowledgeSkills(knowledge);
  const extractor = new VideoKnowledgeExtractor(engine);
  const origins = new VideoOriginCandidates(engine);
  const retention = new VideoRetentionImpact(knowledge);
  return async (method: string | undefined, url: URL, ctx: ExecutionContext, body: () => Promise<any>, key: string): Promise<{ status: number; data: any } | undefined> => {
    const p = url.pathname, input = Object.fromEntries(url.searchParams);
    const governed = p.startsWith("/v1/knowledge") || p.startsWith("/v1/video/skill-candidates");
    const readOrRevoke = method === "GET" || ["/v1/knowledge/search", "/v1/knowledge/research", "/v1/knowledge/snapshots", "/v1/video/skill-candidates/check-pin"].includes(p) || p.endsWith("/withdraw");
    if (governed && !readOrRevoke) assertKnowledgeEnabled(engine, ctx);
    const result = async (data: Promise<any>, status = 200) => ({ status, data: await data });
    let match: RegExpMatchArray | null;
    if (method === "GET" && p === "/v1/knowledge/extractions") return result(extractor.list(ctx, input));
    if (method === "POST" && p === "/v1/knowledge/extractions") return result(extractor.request(ctx, key, await body()), 202);
    if (method === "GET" && (match = p.match(/^\/v1\/knowledge\/extractions\/([\w-]+)$/))) return result(extractor.get(ctx, match[1]));
    if (method === "POST" && (match = p.match(/^\/v1\/knowledge\/extractions\/([\w-]+)\/retry$/))) return result(extractor.retry(ctx, match[1], key, await body()), 202);
    if (method === "GET" && (match = p.match(/^\/v1\/knowledge\/model-authorization\/([\w-]+)$/))) return result(extractor.modelAuthorization(ctx, match[1], url.searchParams.get("purpose") ?? ""));
    if (method === "GET" && p === "/v1/knowledge") return result(knowledge.list(ctx, input));
    if (method === "POST" && p === "/v1/knowledge") return result(knowledge.create(ctx, key, await body()), 201);
    if (method === "POST" && p === "/v1/knowledge/search") return result(knowledge.list(ctx, await body(), true));
    if (method === "POST" && p === "/v1/knowledge/research") return result(knowledge.research(ctx, await body()));
    if (method === "POST" && p === "/v1/knowledge/batch-review") return result(knowledge.batchReview(ctx, await body()));
    if (method === "POST" && p === "/v1/knowledge/origins") return result(knowledge.origins(ctx, key, await body()));
    if (method === "GET" && p === "/v1/knowledge/origin-candidates") return result(origins.list(ctx, input));
    if (method === "POST" && (match = p.match(/^\/v1\/knowledge\/origin-candidates\/([\w-]+)\/review$/))) return result(origins.review(ctx, match[1], key, await body()));
    if (method === "POST" && p === "/v1/knowledge/snapshots") return result(knowledge.pinSnapshot(ctx, await body()));
    if (method === "POST" && p === "/v1/video/retention") return result(knowledge.retention(ctx, key, await body()));
    if (method === "POST" && p === "/v1/video/retention/preview") return result(retention.preview(ctx, await body()));
    if (method === "POST" && p === "/v1/video/retention/batch") return result(retention.batch(ctx, await body()));
    if (method === "GET" && p === "/v1/video/retention/projection-feed") return result(knowledge.projectionFeed(ctx, input));
    if ((match = p.match(/^\/v1\/knowledge\/([\w-]+)$/))) {
      if (method === "GET") return result(knowledge.get(ctx, match[1], url.searchParams.get("mode") !== "review", url.searchParams.get("snapshot_id") ?? undefined));
      if (method === "PATCH") return result(knowledge.edit(ctx, match[1], key, await body()));
    }
    if (method === "POST" && (match = p.match(/^\/v1\/knowledge\/([\w-]+)\/(review|publish|withdraw)$/))) {
      const fn = match[2] as "review" | "publish" | "withdraw";
      return result(knowledge[fn](ctx, match[1], key, await body()));
    }
    if (p === "/v1/video/skill-candidates") {
      if (method === "GET") return result(skills.list(ctx, input));
      if (method === "POST") return result(skills.create(ctx, key, await body()), 201);
    }
    if (method === "POST" && p === "/v1/video/skill-candidates/check-pin") return result(skills.checkPin(ctx, await body()));
    if (method === "GET" && (match = p.match(/^\/v1\/video\/skill-candidates\/([\w-]+)$/))) return result(skills.get(ctx, match[1]));
    if (method === "POST" && (match = p.match(/^\/v1\/video\/skill-candidates\/([\w-]+)\/deployment-check$/))) return result(skills.deploymentCheck(ctx, match[1], await body()));
    if (method === "POST" && (match = p.match(/^\/v1\/video\/skill-candidates\/([\w-]+)\/(evaluation-request|evaluate|review|export|receipts)$/))) {
      const fn = { "evaluation-request": "requestEvaluation", evaluate: "evaluate", review: "review", export: "export", receipts: "receipt" }[match[2]] as "requestEvaluation" | "evaluate" | "review" | "export" | "receipt";
      return result(skills[fn](ctx, match[1], key, await body()));
    }
    return undefined;
  };
}
