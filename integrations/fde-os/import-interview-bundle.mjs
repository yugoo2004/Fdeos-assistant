#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const INTERVIEW_BUNDLE_SCHEMA = "fde_interview_bundle.v1";
export const FDE_OS_TARGET = "fde-os-electron";
export const STORE_PATCH_SCHEMA = "fde_os_interview_import_patch.v1";

const REQUIRED_ARTIFACTS = new Set(["audio.raw_wav", "requirements_analysis.markdown", "prd.markdown"]);
const SECRET_TOKEN_PATTERN = /\b(?:sk|ark)-[A-Za-z0-9_-]{12,}\b/g;

export function validateInterviewBundle(bundle) {
  const issues = [];
  const addIssue = (severity, code, message, path = "") => {
    issues.push({ severity, code, message, path });
  };

  const sessionId = bundle?.session?.id || "";
  const artifacts = Array.isArray(bundle?.artifacts) ? bundle.artifacts : [];
  const requirements = Array.isArray(bundle?.requirements) ? bundle.requirements : [];
  const correctionSuggestions = Array.isArray(bundle?.correction_suggestions) ? bundle.correction_suggestions : [];
  const objectRefs = Array.isArray(bundle?.fde_os_objects) ? bundle.fde_os_objects : [];
  const artifactByKind = new Map(artifacts.map((artifact) => [artifact.kind, artifact]));
  const objectIds = objectRefs.map((item) => item.object_id).filter(Boolean);
  const duplicateObjectIds = [...new Set(objectIds.filter((id, index) => objectIds.indexOf(id) !== index))];
  const requirementWithEvidence = requirements.filter((item) => Array.isArray(item.evidence_refs) && item.evidence_refs.length).length;
  const confirmedEvidence = requirements.filter((item) =>
    (item.evidence_refs || []).some((evidence) => evidence.review_status === "confirmed"),
  ).length;
  const pendingCorrections = correctionSuggestions.filter((item) => item.status === "pending").length;
  const summary = {
    artifact_total: artifacts.length,
    artifact_ready: artifacts.filter((artifact) => artifact.exists).length,
    object_ref_total: objectRefs.length,
    requirement_total: requirements.length,
    requirement_with_evidence: requirementWithEvidence,
    confirmed_evidence: confirmedEvidence,
    transcript_turn_total: Array.isArray(bundle?.transcript) ? bundle.transcript.length : 0,
    transcript_segment_total: Array.isArray(bundle?.transcript_segments) ? bundle.transcript_segments.length : 0,
    correction_suggestion_total: correctionSuggestions.length,
    pending_correction_suggestion: pendingCorrections,
  };

  if (!bundle || typeof bundle !== "object") {
    addIssue("error", "bundle_not_object", "对象包不是有效 JSON object。", "bundle");
  }
  if (bundle?.schema_version !== INTERVIEW_BUNDLE_SCHEMA) {
    addIssue(
      "error",
      "schema_version_mismatch",
      `对象包版本应为 ${INTERVIEW_BUNDLE_SCHEMA}，当前为 ${bundle?.schema_version || "missing"}。`,
      "schema_version",
    );
  }
  if (bundle?.integration_target !== FDE_OS_TARGET) {
    addIssue(
      "error",
      "integration_target_mismatch",
      `目标集成端应为 ${FDE_OS_TARGET}，当前为 ${bundle?.integration_target || "missing"}。`,
      "integration_target",
    );
  }
  if (!sessionId) {
    addIssue("error", "session_id_missing", "对象包缺少 session.id。", "session.id");
  }
  if (bundle?.template?.id !== bundle?.session?.template_id) {
    addIssue("error", "template_session_mismatch", "session.template_id 与 template.id 不一致。", "template.id");
  }
  if (bundle?.audio?.session_id !== sessionId) {
    addIssue("error", "audio_session_mismatch", "audio.session_id 与 session.id 不一致。", "audio.session_id");
  }
  if (bundle?.corrected_transcript?.session_id !== sessionId) {
    addIssue(
      "error",
      "corrected_transcript_session_mismatch",
      "corrected_transcript.session_id 与 session.id 不一致。",
      "corrected_transcript.session_id",
    );
  }
  if (bundle?.analysis?.session_id !== sessionId) {
    addIssue("error", "analysis_session_mismatch", "analysis.session_id 与 session.id 不一致。", "analysis.session_id");
  }

  for (const kind of [...REQUIRED_ARTIFACTS].sort()) {
    const artifact = artifactByKind.get(kind);
    if (!artifact) {
      addIssue("error", "required_artifact_missing", `缺少必需 artifact: ${kind}。`, "artifacts");
    } else if (!artifact.exists) {
      addIssue("error", "required_artifact_not_ready", `必需 artifact 尚未生成: ${kind}。`, `artifacts.${kind}`);
    }
  }
  const bundleArtifact = artifactByKind.get("fde_os_bundle.json");
  if (!bundleArtifact?.exists) {
    addIssue(
      "warning",
      "bundle_file_not_exported",
      "对象包预览已可构建，但 fde_os_bundle.json 文件尚未导出。",
      "artifacts.fde_os_bundle.json",
    );
  }

  if (!bundle?.audio?.exists) {
    addIssue("error", "audio_evidence_missing", "整段访谈录音 raw.wav 不存在，无法满足事后复核要求。", "audio");
  } else if (!bundle.audio.sha256) {
    addIssue("error", "audio_hash_missing", "整段访谈录音缺少 SHA256，无法做审计校验。", "audio.sha256");
  }
  if (bundle?.audio?.path && isUnsafeBundlePath(bundle.audio.path)) {
    addIssue("error", "unsafe_audio_path", "录音路径不是安全的对象包相对路径。", "audio.path");
  }
  for (const artifact of artifacts) {
    if (artifact?.path && isUnsafeBundlePath(artifact.path)) {
      addIssue("error", "unsafe_artifact_path", `Artifact 路径不是安全的对象包相对路径: ${artifact.kind}。`, "artifacts.path");
    }
  }

  if (!summary.transcript_turn_total) {
    addIssue("warning", "transcript_empty", "转写为空，导入后只能作为空访谈草稿。", "transcript");
  }
  if (!summary.transcript_segment_total) {
    addIssue("warning", "transcript_segments_empty", "转写片段为空，需求证据无法精确回放。", "transcript_segments");
  }
  if (!String(bundle?.corrected_transcript?.corrected_text || "").trim()) {
    addIssue("warning", "corrected_transcript_empty", "转写校对稿为空，后续 PRD 可能只依赖原始转写。", "corrected_transcript");
  }
  if (!requirements.length) {
    addIssue("warning", "requirements_empty", "需求项为空，导入后不会生成可开发需求候选。", "requirements");
  } else if (requirementWithEvidence < requirements.length) {
    addIssue(
      "warning",
      "requirement_evidence_incomplete",
      `${requirements.length - requirementWithEvidence} 个需求项还没有绑定录音证据。`,
      "requirements",
    );
  }
  if (requirements.length && confirmedEvidence === 0) {
    addIssue(
      "warning",
      "no_confirmed_evidence",
      "当前需求证据均未人工确认；导入 FDE OS 后应进入质检待办。",
      "requirements.evidence_refs",
    );
  }
  if (pendingCorrections) {
    addIssue("warning", "pending_corrections", `仍有 ${pendingCorrections} 条错词建议待确认。`, "correction_suggestions");
  }
  if (bundle?.analysis?.status === "fallback") {
    addIssue("warning", "analysis_is_local_draft", "当前分析为本地草稿，正式交付前建议运行 API 增强分析。", "analysis.status");
  }
  if (duplicateObjectIds.length) {
    addIssue(
      "error",
      "duplicate_object_ids",
      `fde_os_objects 存在重复 object_id: ${duplicateObjectIds.slice(0, 5).join(", ")}。`,
      "fde_os_objects",
    );
  }
  if (!objectRefs.some((item) => item.object_type === "InterviewSession")) {
    addIssue("error", "interview_object_missing", "fde_os_objects 缺少 InterviewSession 根对象。", "fde_os_objects");
  }
  if (bundle?.audio?.exists && !objectRefs.some((item) => item.object_type === "AudioEvidence")) {
    addIssue("warning", "audio_object_missing", "fde_os_objects 缺少 AudioEvidence 引用。", "fde_os_objects");
  }
  if (JSON.stringify(bundle).match(SECRET_TOKEN_PATTERN)) {
    addIssue("error", "secret_token_leak", "对象包中疑似包含 API key 或访问令牌，禁止导入或分发。", "bundle");
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    session_id: sessionId,
    schema_version: bundle?.schema_version || "",
    valid: errorCount === 0,
    import_ready: errorCount === 0,
    readiness_label: errorCount ? "blocked" : warningCount ? "review_required" : "ready",
    summary,
    issues,
  };
}

export function buildFdeOsStorePatch(bundle, options = {}) {
  const validation = validateInterviewBundle(bundle);
  if (!validation.import_ready && !options.allowBlocked) {
    const errors = validation.issues.filter((issue) => issue.severity === "error");
    throw new Error(`FDE OS 对象包不可导入: ${errors.map((issue) => issue.code).join(", ")}`);
  }

  const importedAt = options.importedAt || new Date().toISOString();
  const sessionId = bundle.session.id;
  const projectId = options.projectId || `project:${sessionId}`;
  const importId = options.importId || stableId("interview-import", `${projectId}:${sessionId}:${bundle.exported_at || ""}`);
  const interviewSessionId = `interview:${sessionId}`;
  const analysis = bundle.analysis || {};
  const artifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : [];
  const requirements = Array.isArray(bundle.requirements) ? bundle.requirements : [];
  const risks = Array.isArray(bundle.risks) ? bundle.risks : [];
  const openQuestions = Array.isArray(bundle.open_questions) ? bundle.open_questions : [];
  const correctionSuggestions = Array.isArray(bundle.correction_suggestions) ? bundle.correction_suggestions : [];

  const storePatch = {
    interviewSessions: [
      {
        id: interviewSessionId,
        project_id: projectId,
        source_session_id: sessionId,
        project_name: bundle.session.project_name,
        customer_name: bundle.session.customer_name,
        template_id: bundle.session.template_id,
        template_name: bundle.template?.name || "",
        mode: bundle.session.mode,
        status: bundle.session.status,
        display_status: bundle.session.display_status,
        created_at: bundle.session.created_at,
        updated_at: bundle.session.updated_at,
        started_at: bundle.session.started_at,
        ended_at: bundle.session.ended_at,
        imported_at: importedAt,
        import_id: importId,
        analysis_engine: analysis.engine || "",
        analysis_status: analysis.status || "",
        readiness_label: validation.readiness_label,
      },
    ],
    audioEvidence: bundle.audio?.exists
      ? [
          {
            id: `audio:${sessionId}:raw_wav`,
            project_id: projectId,
            interview_session_id: interviewSessionId,
            source_session_id: sessionId,
            title: "整段访谈录音",
            path: bundle.audio.path,
            filename: bundle.audio.filename,
            size_bytes: bundle.audio.size_bytes || 0,
            duration_ms: bundle.audio.duration_ms,
            sample_rate: bundle.audio.sample_rate,
            channels: bundle.audio.channels,
            sha256: bundle.audio.sha256,
            updated_at: bundle.audio.updated_at,
            imported_at: importedAt,
            audit_role: "primary_interview_evidence",
          },
        ]
      : [],
    transcripts: [
      {
        id: `transcript:${sessionId}:raw`,
        project_id: projectId,
        interview_session_id: interviewSessionId,
        source_session_id: sessionId,
        kind: "raw_asr",
        turn_count: Array.isArray(bundle.transcript) ? bundle.transcript.length : 0,
        turns: bundle.transcript || [],
        imported_at: importedAt,
      },
      {
        id: `transcript:${sessionId}:corrected`,
        project_id: projectId,
        interview_session_id: interviewSessionId,
        source_session_id: sessionId,
        kind: "corrected",
        corrected_text: bundle.corrected_transcript?.corrected_text || "",
        original_text: bundle.corrected_transcript?.original_text || "",
        corrections: bundle.corrected_transcript?.corrections || [],
        uncertain_segments: bundle.corrected_transcript?.uncertain_segments || [],
        source: bundle.corrected_transcript?.source || "",
        updated_at: bundle.corrected_transcript?.updated_at || "",
        imported_at: importedAt,
      },
    ],
    transcriptSegments: (bundle.transcript_segments || []).map((segment) => ({
      ...segment,
      project_id: projectId,
      interview_session_id: interviewSessionId,
      source_session_id: sessionId,
      fde_os_id: `transcript_segment:${sessionId}:${segment.id}`,
      imported_at: importedAt,
    })),
    transcriptCorrectionSuggestions: correctionSuggestions.map((suggestion) => ({
      ...suggestion,
      project_id: projectId,
      interview_session_id: interviewSessionId,
      source_session_id: sessionId,
      fde_os_id: `correction:${sessionId}:${suggestion.id}`,
      qa_state: suggestion.status === "pending" ? "action_required" : "resolved",
      imported_at: importedAt,
    })),
    requirements: requirements.map((requirement) => {
      const evidenceRefs = Array.isArray(requirement.evidence_refs) ? requirement.evidence_refs : [];
      const hasConfirmedEvidence = evidenceRefs.some((evidence) => evidence.review_status === "confirmed");
      return {
        id: `requirement:${requirement.id}`,
        source_requirement_id: requirement.id,
        project_id: projectId,
        interview_session_id: interviewSessionId,
        title: requirement.title,
        description: requirement.description,
        type: requirement.type,
        priority: requirement.priority,
        module: requirement.module,
        user_story: requirement.user_story,
        business_rules: requirement.business_rules || [],
        data_entities: requirement.data_entities || [],
        dependencies: requirement.dependencies || [],
        acceptance_criteria: requirement.acceptance_criteria || [],
        confidence: requirement.confidence,
        created_at: requirement.created_at,
        imported_at: importedAt,
        evidence_count: evidenceRefs.length,
        has_confirmed_evidence: hasConfirmedEvidence,
        can_create_delivery_task: hasConfirmedEvidence,
        qa_state: hasConfirmedEvidence ? "ready" : evidenceRefs.length ? "needs_evidence_review" : "missing_evidence",
      };
    }),
    requirementEvidenceRefs: requirements.flatMap((requirement) =>
      (requirement.evidence_refs || []).map((evidence) => ({
        id: `requirement_evidence:${requirement.id}:${evidence.id}`,
        source_evidence_id: evidence.id,
        project_id: projectId,
        interview_session_id: interviewSessionId,
        requirement_id: `requirement:${requirement.id}`,
        source_requirement_id: requirement.id,
        transcript_segment_id: evidence.transcript_segment_id
          ? `transcript_segment:${sessionId}:${evidence.transcript_segment_id}`
          : "",
        source_transcript_segment_id: evidence.transcript_segment_id,
        transcript_turn_id: evidence.transcript_turn_id,
        transcript_excerpt: evidence.transcript_excerpt,
        corrected_excerpt: evidence.corrected_excerpt,
        start_ms: evidence.start_ms,
        end_ms: evidence.end_ms,
        source: evidence.source,
        confidence: evidence.confidence,
        review_status: evidence.review_status,
        review_note: evidence.review_note,
        reviewed_at: evidence.reviewed_at,
        audio_evidence_id: bundle.audio?.exists ? `audio:${sessionId}:raw_wav` : "",
        imported_at: importedAt,
      })),
    ),
    risks: risks.map((risk) => ({
      ...risk,
      id: `risk:${risk.id}`,
      source_risk_id: risk.id,
      project_id: projectId,
      interview_session_id: interviewSessionId,
      imported_at: importedAt,
    })),
    openQuestions: openQuestions.map((question) => ({
      ...question,
      id: `open_question:${question.id}`,
      source_open_question_id: question.id,
      project_id: projectId,
      interview_session_id: interviewSessionId,
      qa_state: "open",
      imported_at: importedAt,
    })),
    prdArtifacts: artifacts
      .filter((artifact) => artifact.exists)
      .map((artifact) => ({
        id: `artifact:${sessionId}:${artifact.kind}`,
        project_id: projectId,
        interview_session_id: interviewSessionId,
        kind: artifact.kind,
        title: artifact.filename || basename(artifact.path || artifact.kind),
        path: artifact.path,
        filename: artifact.filename,
        media_type: artifact.media_type,
        imported_at: importedAt,
      })),
    importWarnings: validation.issues.map((issue) => ({
      id: stableId("interview-import-issue", `${importId}:${issue.code}:${issue.path}:${issue.message}`),
      project_id: projectId,
      interview_session_id: interviewSessionId,
      import_id: importId,
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      path: issue.path,
      status: issue.severity === "error" ? "blocked" : "open",
      created_at: importedAt,
    })),
  };

  return {
    schema_version: STORE_PATCH_SCHEMA,
    created_at: importedAt,
    import_id: importId,
    project_id: projectId,
    interview_session_id: interviewSessionId,
    source: {
      schema_version: bundle.schema_version,
      exported_at: bundle.exported_at,
      source_app: bundle.source_app,
      integration_target: bundle.integration_target,
      session_id: sessionId,
    },
    validation,
    qa_tasks: buildQaTasks({
      projectId,
      interviewSessionId,
      importId,
      importedAt,
      requirements,
      correctionSuggestions,
      issues: validation.issues,
    }),
    store_patch: storePatch,
  };
}

function buildQaTasks({ projectId, interviewSessionId, importId, importedAt, requirements, correctionSuggestions, issues }) {
  const tasks = [];
  for (const issue of issues) {
    if (issue.severity !== "warning") {
      continue;
    }
    tasks.push({
      id: stableId("qa", `${importId}:issue:${issue.code}:${issue.path}`),
      project_id: projectId,
      interview_session_id: interviewSessionId,
      type: "bundle_warning",
      title: issue.message,
      source_code: issue.code,
      status: "open",
      created_at: importedAt,
    });
  }
  for (const requirement of requirements) {
    const evidenceRefs = requirement.evidence_refs || [];
    if (!evidenceRefs.length) {
      tasks.push({
        id: stableId("qa", `${importId}:missing-evidence:${requirement.id}`),
        project_id: projectId,
        interview_session_id: interviewSessionId,
        type: "requirement_evidence",
        title: `需求缺少录音证据: ${requirement.title}`,
        requirement_id: `requirement:${requirement.id}`,
        status: "open",
        created_at: importedAt,
      });
      continue;
    }
    if (!evidenceRefs.some((evidence) => evidence.review_status === "confirmed")) {
      tasks.push({
        id: stableId("qa", `${importId}:unconfirmed-evidence:${requirement.id}`),
        project_id: projectId,
        interview_session_id: interviewSessionId,
        type: "requirement_evidence",
        title: `需求证据待人工确认: ${requirement.title}`,
        requirement_id: `requirement:${requirement.id}`,
        status: "open",
        created_at: importedAt,
      });
    }
  }
  for (const suggestion of correctionSuggestions) {
    if (suggestion.status !== "pending") {
      continue;
    }
    tasks.push({
      id: stableId("qa", `${importId}:pending-correction:${suggestion.id}`),
      project_id: projectId,
      interview_session_id: interviewSessionId,
      type: "transcript_correction",
      title: `待确认错词: ${suggestion.wrong_text} -> ${suggestion.suggested_text}`,
      correction_suggestion_id: `correction:${suggestion.session_id}:${suggestion.id}`,
      status: "open",
      created_at: importedAt,
    });
  }
  return tasks;
}

function isUnsafeBundlePath(value) {
  if (!value || typeof value !== "string") {
    return false;
  }
  if (value.split(/[\\/]+/).includes("..")) {
    return true;
  }
  const normalized = normalize(value);
  return isAbsolute(value) || normalized === ".." || normalized.startsWith(`..${sep}`);
}

function stableId(prefix, value) {
  return `${prefix}:${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const args = {
    bundlePath: "",
    outPath: "",
    projectId: "",
    allowBlocked: false,
    strictReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      args.outPath = argv[++index] || "";
    } else if (arg === "--project-id") {
      args.projectId = argv[++index] || "";
    } else if (arg === "--allow-blocked") {
      args.allowBlocked = true;
    } else if (arg === "--strict-ready") {
      args.strictReady = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (!args.bundlePath) {
      args.bundlePath = arg;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node integrations/fde-os/import-interview-bundle.mjs <fde_os_bundle.json> [--out fde_os_store_patch.json] [--project-id project:xxx]",
    "",
    "Exit codes:",
    "  0: ready or review_required",
    "  2: blocked",
    "  3: strict-ready mode found warnings",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.bundlePath) {
    console.log(usage());
    return;
  }
  const bundle = await readJsonFile(args.bundlePath);
  const patch = buildFdeOsStorePatch(bundle, {
    projectId: args.projectId,
    allowBlocked: args.allowBlocked,
  });
  if (args.outPath) {
    await writeJsonFile(args.outPath, patch);
  }

  const response = {
    readiness_label: patch.validation.readiness_label,
    import_ready: patch.validation.import_ready,
    project_id: patch.project_id,
    interview_session_id: patch.interview_session_id,
    output_path: args.outPath || "",
    summary: patch.validation.summary,
    issue_count: patch.validation.issues.length,
    qa_task_count: patch.qa_tasks.length,
    store_counts: Object.fromEntries(Object.entries(patch.store_patch).map(([key, value]) => [key, value.length])),
  };
  console.log(JSON.stringify(response, null, 2));
  if (!patch.validation.import_ready) {
    process.exitCode = 2;
  } else if (args.strictReady && patch.validation.readiness_label !== "ready") {
    process.exitCode = 3;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
