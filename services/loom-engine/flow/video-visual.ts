import { canonicalHash, sha, videoError, type VideoManifest, type VideoSegment } from "./video-contract.ts";

const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
function decimal(value: unknown) {
  if (typeof value !== "string" || value.length > 128 || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const magnitude = (whole.replace(/^0+(?=\d)/, "") || "0") + (fraction.replace(/0+$/, "") ? `.${fraction.replace(/0+$/, "")}` : "");
  return value.startsWith("-") && magnitude !== "0" ? `-${magnitude}` : magnitude;
}
function scalar(text: string, label: string, unit: string) {
  const values = new Set<string>();
  for (const clause of text.normalize("NFKC").toLowerCase().split(/[\n;；,，]/)) {
    const match = /^\s*([^:=\n]{1,40}?)\s*[:=]\s*([+-]?\d+(?:\.\d+)?)\s*([\p{L}]+(?:\/[\p{L}]+)?|[%°][\p{L}]*)\s*$/u.exec(clause);
    if (match && match[1].trim().replace(/\s+/g, " ") === label && match[3] === unit) { const value = decimal(match[2]); if (value !== null) values.add(value); }
  }
  return values.size === 1 ? [...values][0] : null;
}

/** Page records preserve provenance labels; derived model text is never promoted into source evidence. */
export function validateVisualPart(manifest: VideoManifest, part: NonNullable<VideoManifest["visual"]>["parts"][number], bytes: Uint8Array, segments?: VideoSegment[]) {
  if (part.bytes !== bytes.byteLength || bytes.byteLength > 256 * 1024 || part.content_type !== "application/json") throw videoError(422, "INVALID_VISUAL_PART");
  let payload: any; try { payload = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw videoError(422, "INVALID_VISUAL_PART"); }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.records) || payload.records.length !== part.record_count || !integer(part.record_count, 1, 100)) throw videoError(422, "VISUAL_COUNT_MISMATCH");
  const frames = new Map((manifest.frames ?? []).map(frame => [frame.object_key, frame]));
  const duration = Number(manifest.coverage.duration_ms ?? 86_400_000);
  for (const record of payload.records) {
    if (!record || typeof record !== "object" || !["frame", "ocr", "model_observation", "model_inference", "alignment"].includes(record.type)) throw videoError(422, "INVALID_VISUAL_RECORD");
    const { record_id, ...value } = record;
    if (record_id !== canonicalHash(value) || !integer(record.start_ms, 0, duration) || !integer(record.end_ms, record.start_ms, duration)) throw videoError(422, "INVALID_VISUAL_RECORD");
    const refs = record.frame_refs ?? (record.frame_ref ? [record.frame_ref] : []);
    if (!Array.isArray(refs) || !refs.length || refs.some((key: string) => !frames.has(key))) throw videoError(422, "INVALID_FRAME_REFERENCE");
    if (record.type !== "alignment" && record.media_sha256 !== manifest.media_sha256) throw videoError(422, "INVALID_MEDIA_HASH");
    if (record.frame_ref) {
      const frame = frames.get(record.frame_ref)!;
      if (record.frame_id !== frame.frame_id || record.frame_sha256 && record.frame_sha256 !== frame.sha256 || record.start_ms > frame.timestamp_ms || record.end_ms < frame.timestamp_ms) throw videoError(422, "INVALID_FRAME_REFERENCE");
    }
    if (record.type === "ocr" && (typeof record.text !== "string" || record.observed_text !== record.text || record.review_status !== "unreviewed")) throw videoError(422, "INVALID_VISUAL_RECORD");
    if (record.type.startsWith("model_")) {
      if (record.derived !== true || typeof record.text !== "string" || record.review_status !== "unreviewed" || !Array.isArray(record.provenance?.model_tasks) || !record.provenance.model_tasks.length) throw videoError(422, "INVALID_VISUAL_PROVENANCE");
      const tasks = record.provenance.model_tasks;
      if (tasks.length > 1000 || new Set(tasks.map((task: any) => task?.task_id)).size !== tasks.length || tasks.some((task: any) =>
        !task || typeof task.task_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(task.task_id)
        || task.usage_ref !== `model_task:${task.task_id}` || typeof task.model_config_hash !== "string" || !/^[a-f0-9]{64}$/.test(task.model_config_hash))) throw videoError(422, "INVALID_VISUAL_PROVENANCE");
      if (!Array.isArray(record.frame_ids) || record.frame_ids.length !== refs.length || new Set(refs).size !== refs.length || new Set(record.frame_ids).size !== record.frame_ids.length
        || refs.some((key: string, index: number) => record.frame_ids[index] !== frames.get(key)!.frame_id)
        || record.start_ms !== Math.min(...refs.map((key: string) => frames.get(key)!.timestamp_ms)) || record.end_ms !== Math.max(...refs.map((key: string) => frames.get(key)!.timestamp_ms))) throw videoError(422, "INVALID_FRAME_REFERENCE");
    }
    if (record.type === "alignment" && (!["temporal_overlap", "unaligned"].includes(record.relation) || record.semantic_relation !== "not_assessed" || !Array.isArray(record.audio_segments) || record.audio_segments.length > 32)) throw videoError(422, "INVALID_ALIGNMENT");
    if (record.type === "alignment" && (record.relation === "unaligned" && record.audio_segments.length || record.relation === "temporal_overlap" && !record.audio_segments.length
      || record.audio_segments.some((segment: any) => !segment || !integer(segment.start_ms, 0, record.start_ms) || !integer(segment.end_ms, record.end_ms, duration) || !/^[a-f0-9]{64}$/.test(segment.text_sha256)))) throw videoError(422, "INVALID_ALIGNMENT");
    if (record.type === "alignment" && segments && record.audio_segments.some((ref: any) => !segments.some(segment => ["asr", "subtitle"].includes(segment.kind ?? "subtitle") && segment.start_ms === ref.start_ms && segment.end_ms === ref.end_ms && sha(segment.text) === ref.text_sha256))) throw videoError(422, "INVALID_ALIGNMENT_SOURCE");
    if (record.conflict_candidates !== undefined) {
      if (record.type !== "alignment" || !Array.isArray(record.conflict_candidates) || record.conflict_candidates.length > 8) throw videoError(422, "INVALID_CONFLICT_CANDIDATE");
      for (const candidate of record.conflict_candidates) {
        if (!candidate || candidate.relation !== "numeric_disagreement_candidate" || candidate.review_status !== "unreviewed" || candidate.truth_status !== "not_asserted"
          || typeof candidate.label !== "string" || candidate.label.length > 80 || typeof candidate.unit !== "string" || candidate.unit.length > 40
          || decimal(candidate.audio_value) === null || decimal(candidate.visual_value) === null || decimal(candidate.audio_value) === decimal(candidate.visual_value)) throw videoError(422, "INVALID_CONFLICT_CANDIDATE");
        for (const side of ["audio", "visual"]) {
          const value = candidate[side];
          if (!value || typeof value.text !== "string" || Buffer.byteLength(value.text) > 8192 || sha(value.text) !== value.text_sha256 || !integer(value.start_ms, 0, record.start_ms) || !integer(value.end_ms, record.end_ms, duration)) throw videoError(422, "INVALID_CONFLICT_SOURCE");
          if (side === "visual" && value.frame_ref !== record.frame_ref) throw videoError(422, "INVALID_CONFLICT_SOURCE");
          if (scalar(value.text, candidate.label, candidate.unit) !== decimal(candidate[`${side}_value`])) throw videoError(422, "INVALID_CONFLICT_SOURCE");
          if (segments && !segments.some(segment => segment.text === value.text && segment.start_ms === value.start_ms && segment.end_ms === value.end_ms && (side === "audio" ? ["asr", "subtitle"].includes(segment.kind ?? "subtitle") : segment.kind === "ocr" && segment.frame_ref === record.frame_ref))) throw videoError(422, "INVALID_CONFLICT_SOURCE");
        }
      }
    }
  }
  if (Math.min(...payload.records.map((r: any) => r.start_ms)) !== part.start_ms || Math.max(...payload.records.map((r: any) => r.end_ms)) !== part.end_ms) throw videoError(422, "VISUAL_RANGE_MISMATCH");
  return payload.records as Record<string, any>[];
}
