import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowLeftRight,
  Captions,
  Check,
  CircleStop,
  Download,
  ExternalLink,
  FileJson,
  FileText,
  ListChecks,
  LockKeyhole,
  MonitorUp,
  Mic,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  ShieldAlert,
  SkipForward,
  Trash2,
  Volume2,
  Wand2,
} from "lucide-react";
import "./styles.css";

const API_BASE =
  window.__FDE_INTERVIEW_API_BASE__ ||
  (import.meta as unknown as { env?: { VITE_FDE_API_BASE?: string } }).env?.VITE_FDE_API_BASE ||
  "http://127.0.0.1:8765/api";
const DEMO_SESSION_ID = "demo_session";
const DEMO_TEMPLATE_ID = "default_interview_template";
const DEMO_TEMPLATE_NAME = "本地访谈模板";
const QUESTION_DELIVERY_MODE_KEY = "fde-question-delivery-mode";
const AUTO_READ_FIRST_QUESTION_KEY = "fde-auto-read-first-question";
const DISPLAY_LAYOUT_KEY = "fde-secondary-display-layout-v1";
const DISPLAY_BOUNDS_PREFIX = "fde-secondary-display-bounds";
const EVIDENCE_REVIEW_META: Record<EvidenceReviewStatus, { label: string; action: string }> = {
  unreviewed: { label: "未复核", action: "重置未复核" },
  confirmed: { label: "已确认", action: "确认此证据" },
  needs_relocation: { label: "需重定位", action: "标记需重定位" },
};
const SPEAKER_OPTIONS: Array<{ value: SpeakerRole; label: string }> = [
  { value: "fde", label: "FDE" },
  { value: "customer", label: "客户" },
  { value: "ai", label: "AI" },
  { value: "unknown", label: "未知" },
];

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
    __FDE_INTERVIEW_API_BASE__?: string;
  }
}

type Health = {
  ok: boolean;
  service: string;
  data_dir: string;
  templates_dir: string;
  transcription?: {
    mode: "local_only";
    engine: string;
    external_asr_enabled: boolean;
    model_dir: string;
    model_ready: boolean;
    vad?: {
      min_segment_ms: number;
      max_segment_ms: number;
      split_silence_ms: number;
    };
  };
  demo?: {
    session_id: string;
    readonly: boolean;
  };
};

type Template = {
  id: string;
  name: string;
  domain: string;
  description: string;
  roles: string[];
  interview_stages: string[];
  required_questions: string[];
};

type DisplayStatus = "standby" | "on_air" | "processing";

type Session = {
  id: string;
  project_name: string;
  customer_name: string;
  template_id: string;
  mode: "copilot" | "ai_host";
  status: string;
  display_status: DisplayStatus;
  created_at: string;
  audio_path: string | null;
  transcript_count: number;
  requirement_count: number;
};

type SpeakerRole = "fde" | "customer" | "ai" | "unknown";

type TranscriptTurn = {
  id: string;
  speaker: SpeakerRole;
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number | null;
  source: "asr" | "manual" | "pending_asr";
  created_at: string;
};

type RunAsrResponse = {
  session_id: string;
  transcript: TranscriptTurn[];
  engine: string;
  status: "completed" | "pending_model";
  message: string;
};

type CorrectedTranscript = {
  session_id: string;
  original_text: string;
  corrected_text: string;
  corrections: string[];
  uncertain_segments: string[];
  source: "local_glossary" | "manual" | "llm";
  updated_at: string;
};

type CorrectionSuggestionStatus = "pending" | "auto_applied" | "applied" | "ignored";

type TranscriptCorrectionOccurrence = {
  transcript_segment_id: string;
  transcript_turn_id: string;
  start_ms: number;
  end_ms: number;
  excerpt: string;
};

type TranscriptCorrectionSuggestion = {
  id: string;
  session_id: string;
  wrong_text: string;
  suggested_text: string;
  occurrence_count: number;
  occurrences: TranscriptCorrectionOccurrence[];
  confidence: number;
  source: "glossary" | "domain_pattern" | "context_hint" | "agent";
  status: CorrectionSuggestionStatus;
  safe_auto_apply: boolean;
  reason: string;
  created_at: string;
  updated_at: string;
};

type EvidenceReviewStatus = "unreviewed" | "confirmed" | "needs_relocation";

type TranscriptSegment = {
  id: string;
  session_id: string;
  transcript_turn_id: string;
  sequence: number;
  speaker: SpeakerRole;
  text: string;
  corrected_text: string;
  start_ms: number;
  end_ms: number;
  source: "asr" | "corrected" | "manual";
  confidence: number | null;
  created_at: string;
};

type EvidenceReference = {
  id: string;
  transcript_segment_id: string;
  transcript_turn_id: string;
  transcript_excerpt: string;
  corrected_excerpt: string;
  start_ms: number;
  end_ms: number;
  source: "auto_match" | "manual" | "llm";
  confidence: number;
  review_status: EvidenceReviewStatus;
  review_note: string;
  reviewed_at: string | null;
};

type RequirementItem = {
  id: string;
  title: string;
  description: string;
  type: string;
  priority: string;
  module: string;
  user_story: string;
  business_rules: string[];
  data_entities: string[];
  dependencies: string[];
  evidence: string;
  evidence_refs: EvidenceReference[];
  acceptance_criteria: string[];
  confidence: number;
  created_at: string;
};

type RiskItem = {
  id: string;
  title: string;
  description: string;
  severity: string;
  mitigation: string;
  evidence: string;
  created_at: string;
};

type OpenQuestionItem = {
  id: string;
  question: string;
  reason: string;
  owner_role: string;
  created_at: string;
};

type PrdOutline = {
  product_brief: {
    name: string;
    positioning: string;
    target_users: string[];
    problem_statement: string;
    value_proposition: string;
    scope: string[];
    out_of_scope: string[];
  };
  user_roles: string[];
  user_journeys: {
    actor: string;
    trigger: string;
    steps: string[];
    expected_outcome: string;
  }[];
  feature_modules: {
    name: string;
    goal: string;
    core_capabilities: string[];
    related_requirements: string[];
  }[];
  data_model: string[];
  success_metrics: string[];
  transcript_corrections: string[];
};

type AnalysisResult = {
  session_id: string;
  prd: PrdOutline;
  requirements: RequirementItem[];
  risks: RiskItem[];
  open_questions: OpenQuestionItem[];
  engine: string;
  status: "completed" | "fallback";
  message: string;
};

type AnalysisQualityTone = "ready" | "warn" | "muted" | "running";
type EvidenceCoverageTone = "confirmed" | "located" | "low" | "missing" | "needs";

type MarkdownExportResponse = {
  session_id: string;
  path: string;
  filename: string;
};

type FdeOsBundleValidationSummary = {
  artifact_total: number;
  artifact_ready: number;
  object_ref_total: number;
  requirement_total: number;
  requirement_with_evidence: number;
  confirmed_evidence: number;
  transcript_turn_total: number;
  transcript_segment_total: number;
  correction_suggestion_total: number;
  pending_correction_suggestion: number;
};

type FdeOsBundleValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: string;
};

type FdeOsBundleValidationResult = {
  session_id: string;
  schema_version: string;
  valid: boolean;
  import_ready: boolean;
  readiness_label: "ready" | "review_required" | "blocked";
  summary: FdeOsBundleValidationSummary;
  issues: FdeOsBundleValidationIssue[];
};

type AudioAsset = {
  session_id: string;
  exists: boolean;
  path: string;
  filename: string;
  size_bytes: number;
  duration_ms: number | null;
  sample_rate: number | null;
  channels: number | null;
  sha256: string;
  updated_at: string | null;
};

type AgentQuestionEvent = {
  id: string;
  session_id: string;
  question_id: string;
  question: string;
  reason: string;
  owner_role: string;
  source: string;
  created_at: string;
};

type ProcessSessionResponse = {
  session_id: string;
  asr: RunAsrResponse;
  analysis: AnalysisResult;
  markdown: MarkdownExportResponse;
};

type AnalysisJobResponse = {
  job_id: string;
  session_id: string;
  status: "queued" | "running" | "enhancing" | "completed" | "failed";
  message: string;
  created_at: string;
  updated_at: string;
  analysis: AnalysisResult | null;
  markdown: MarkdownExportResponse | null;
};

type RecorderState = {
  audioContext: AudioContext;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
  chunks: Float32Array[];
  inputSampleRate: number;
};

type ViewMode = "workspace" | "customer" | "fde";
type DisplayRole = "customer" | "fde";
type QuestionDeliveryMode = "tts" | "fde";

type DisplayWindowBounds = {
  screen_x: number;
  screen_y: number;
  outer_width: number;
  outer_height: number;
  updated_at: string;
};

type DisplayLayoutPreference = {
  swapped: boolean;
  calibration: boolean;
  saved_at: string;
  customer?: DisplayWindowBounds;
  fde?: DisplayWindowBounds;
};

function readViewMode(): ViewMode {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "customer" || view === "fde" ? view : "workspace";
}

function readSessionIdFromUrl(): string {
  return new URLSearchParams(window.location.search).get("session") || "";
}

function readQuestionDeliveryMode(): QuestionDeliveryMode {
  try {
    return localStorage.getItem(QUESTION_DELIVERY_MODE_KEY) === "fde" ? "fde" : "tts";
  } catch {
    return "tts";
  }
}

function readAutoReadFirstQuestion(): boolean {
  try {
    return localStorage.getItem(AUTO_READ_FIRST_QUESTION_KEY) !== "false";
  } catch {
    return true;
  }
}

function readDisplayLayoutPreference(): DisplayLayoutPreference {
  try {
    const raw = localStorage.getItem(DISPLAY_LAYOUT_KEY);
    if (!raw) {
      return { swapped: false, calibration: false, saved_at: "" };
    }
    const parsed = JSON.parse(raw) as Partial<DisplayLayoutPreference>;
    return {
      swapped: Boolean(parsed.swapped),
      calibration: Boolean(parsed.calibration),
      saved_at: parsed.saved_at || "",
      customer: parsed.customer,
      fde: parsed.fde,
    };
  } catch {
    return { swapped: false, calibration: false, saved_at: "" };
  }
}

function readDisplayWindowBounds(role: DisplayRole): DisplayWindowBounds | undefined {
  try {
    const raw = localStorage.getItem(`${DISPLAY_BOUNDS_PREFIX}-${role}`);
    return raw ? (JSON.parse(raw) as DisplayWindowBounds) : undefined;
  } catch {
    return undefined;
  }
}

function writeDisplayWindowBounds(role: DisplayRole) {
  try {
    const bounds: DisplayWindowBounds = {
      screen_x: window.screenX,
      screen_y: window.screenY,
      outer_width: window.outerWidth,
      outer_height: window.outerHeight,
      updated_at: new Date().toISOString(),
    };
    localStorage.setItem(`${DISPLAY_BOUNDS_PREFIX}-${role}`, JSON.stringify(bounds));
  } catch {
    // Ignore layout persistence failures in restricted browser contexts.
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

async function uploadRawWav(sessionId: string, wavBlob: Blob): Promise<Session> {
  const formData = new FormData();
  formData.append("file", wavBlob, "raw.wav");
  const response = await fetch(`${API_BASE}/sessions/${sessionId}/audio/raw-wav`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as Session;
}

function mergeFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function downsampleBuffer(buffer: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
  if (outputSampleRate === inputSampleRate) {
    return buffer;
  }
  if (outputSampleRate > inputSampleRate) {
    throw new Error("Output sample rate must be lower than input sample rate");
  }
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(buffer.length / sampleRateRatio);
  const output = new Float32Array(outputLength);
  let inputOffset = 0;
  for (let outputOffset = 0; outputOffset < output.length; outputOffset += 1) {
    const nextInputOffset = Math.round((outputOffset + 1) * sampleRateRatio);
    let accumulator = 0;
    let count = 0;
    for (let index = inputOffset; index < nextInputOffset && index < buffer.length; index += 1) {
      accumulator += buffer[index];
      count += 1;
    }
    output[outputOffset] = count > 0 ? accumulator / count : 0;
    inputOffset = nextInputOffset;
  }
  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function speakerLabel(value: SpeakerRole): string {
  return SPEAKER_OPTIONS.find((item) => item.value === value)?.label || "未知";
}

function formatBytes(bytes: number): string {
  if (!bytes) {
    return "0 KB";
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "未生成";
  }
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function questionEventSourceLabel(source: string): string {
  if (source === "fde_manual") {
    return "FDE 本人";
  }
  if (source === "skipped") {
    return "已跳过";
  }
  if (source === "auto_opening_question") {
    return "TTS 自动开场";
  }
  return "TTS";
}

function formatAnalysisEngine(engine: string | undefined): string {
  if (!engine) {
    return "未记录模型";
  }
  return engine.replace("openai-compatible:", "");
}

function fdeOsReadinessLabel(value: FdeOsBundleValidationResult["readiness_label"] | undefined): string {
  if (value === "ready") {
    return "可导入";
  }
  if (value === "review_required") {
    return "需复核";
  }
  if (value === "blocked") {
    return "阻塞";
  }
  return "检查中";
}

function fdeOsReadinessTone(value: FdeOsBundleValidationResult["readiness_label"] | undefined): AnalysisQualityTone {
  if (value === "ready") {
    return "ready";
  }
  if (value === "blocked" || value === "review_required") {
    return "warn";
  }
  return "muted";
}

function evidenceCoverageMeta(evidence: EvidenceReference | undefined): {
  label: string;
  tone: EvidenceCoverageTone;
  detail: string;
} {
  if (!evidence) {
    return { label: "未定位", tone: "missing", detail: "尚未绑定 raw.wav 时间点" };
  }
  if (evidence.review_status === "confirmed") {
    return { label: "已确认", tone: "confirmed", detail: "FDE 已复核该证据" };
  }
  if (evidence.review_status === "needs_relocation") {
    return { label: "需重定位", tone: "needs", detail: "证据需要人工重新选择片段" };
  }
  if (evidence.confidence < 0.6) {
    return { label: "低置信", tone: "low", detail: "系统已自动候选，需播放复核" };
  }
  return { label: "待复核", tone: "located", detail: "已绑定证据，等待人工确认" };
}

function correctionSuggestionStatusLabel(status: CorrectionSuggestionStatus): string {
  if (status === "auto_applied") {
    return "已自动纠正";
  }
  if (status === "applied") {
    return "已确认应用";
  }
  if (status === "ignored") {
    return "已忽略";
  }
  return "待确认";
}

function correctionSuggestionSourceLabel(source: TranscriptCorrectionSuggestion["source"]): string {
  if (source === "glossary") {
    return "模板词库";
  }
  if (source === "domain_pattern") {
    return "领域规则";
  }
  if (source === "agent") {
    return "Agent";
  }
  return "上下文候选";
}

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projectName, setProjectName] = useState("需求访谈验证项目");
  const [customerName, setCustomerName] = useState("示例客户");
  const [templateId, setTemplateId] = useState(DEMO_TEMPLATE_ID);
  const [mode, setMode] = useState<"copilot" | "ai_host">("copilot");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(readSessionIdFromUrl);
  const [recordingStatus, setRecordingStatus] = useState<"idle" | "recording" | "uploading">("idle");
  const [recordingMessage, setRecordingMessage] = useState("尚未开始录音。");
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [correctedTranscript, setCorrectedTranscript] = useState<CorrectedTranscript | null>(null);
  const [correctedText, setCorrectedText] = useState("");
  const [correctionSuggestions, setCorrectionSuggestions] = useState<TranscriptCorrectionSuggestion[]>([]);
  const [correctionStatus, setCorrectionStatus] = useState<"idle" | "running" | "saving">("idle");
  const [correctionMessage, setCorrectionMessage] = useState("生成转写后可做术语纠错和人工校对。");
  const [suggestionBusy, setSuggestionBusy] = useState("");
  const [asrStatus, setAsrStatus] = useState<"idle" | "running">("idle");
  const [asrMessage, setAsrMessage] = useState("录音保存后可生成转写。");
  const [requirements, setRequirements] = useState<RequirementItem[]>([]);
  const [risks, setRisks] = useState<RiskItem[]>([]);
  const [openQuestions, setOpenQuestions] = useState<OpenQuestionItem[]>([]);
  const [prd, setPrd] = useState<PrdOutline | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "running">("idle");
  const [analysisMessage, setAnalysisMessage] = useState("转写生成后可抽取需求分析。");
  const [exportStatus, setExportStatus] = useState<"idle" | "running">("idle");
  const [exportMessage, setExportMessage] = useState("分析结果生成后可导出需求分析或 PRD。");
  const [fdeOsValidation, setFdeOsValidation] = useState<FdeOsBundleValidationResult | null>(null);
  const [fdeOsValidationMessage, setFdeOsValidationMessage] = useState("正在检查 FDE OS 对象包。");
  const [selectedRequirementId, setSelectedRequirementId] = useState("");
  const [pipelineStatus, setPipelineStatus] = useState<"idle" | "running">("idle");
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [displayLayout, setDisplayLayout] = useState<DisplayLayoutPreference>(readDisplayLayoutPreference);
  const [displayLayoutMessage, setDisplayLayoutMessage] = useState("副屏布局尚未保存。");
  const [displayStatusBusy, setDisplayStatusBusy] = useState(false);
  const [audioAsset, setAudioAsset] = useState<AudioAsset | null>(null);
  const [audioPlayback, setAudioPlayback] = useState<"idle" | "playing" | "paused">("idle");
  const [agentQuestionEvents, setAgentQuestionEvents] = useState<AgentQuestionEvent[]>([]);
  const [ttsStatus, setTtsStatus] = useState<"idle" | "speaking" | "paused">("idle");
  const [currentTtsQuestionId, setCurrentTtsQuestionId] = useState("");
  const [questionDeliveryMode, setQuestionDeliveryMode] = useState<QuestionDeliveryMode>(readQuestionDeliveryMode);
  const [autoReadFirstQuestion, setAutoReadFirstQuestion] = useState(readAutoReadFirstQuestion);
  const [evidenceReviewNote, setEvidenceReviewNote] = useState("");
  const [evidenceReviewBusy, setEvidenceReviewBusy] = useState(false);
  const [relocationSegmentId, setRelocationSegmentId] = useState("");
  const [evidenceRelocationBusy, setEvidenceRelocationBusy] = useState(false);
  const [speakerUpdateId, setSpeakerUpdateId] = useState("");
  const [segmentEditStartMs, setSegmentEditStartMs] = useState("");
  const [segmentEditEndMs, setSegmentEditEndMs] = useState("");
  const [segmentEditSplitMs, setSegmentEditSplitMs] = useState("");
  const [segmentEditText, setSegmentEditText] = useState("");
  const [segmentEditBusy, setSegmentEditBusy] = useState(false);
  const recorderRef = useRef<RecorderState | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const reviewAudioRef = useRef<HTMLAudioElement | null>(null);
  const segmentStopTimerRef = useRef<number | null>(null);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === templateId),
    [templates, templateId],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || sessions[0] || null,
    [activeSessionId, sessions],
  );
  const activeTemplate = useMemo(
    () => templates.find((template) => template.id === activeSession?.template_id),
    [activeSession?.template_id, templates],
  );
  const demoReadonly = health?.demo ? health.demo.readonly : true;
  const demoSessionId = health?.demo?.session_id || DEMO_SESSION_ID;
  const isDemoSession = Boolean(demoReadonly && activeSession?.id === demoSessionId);
  const selectedTemplateName =
    activeTemplate?.name ||
    selectedTemplate?.name ||
    (templateId === DEMO_TEMPLATE_ID ? DEMO_TEMPLATE_NAME : activeSession?.template_id || "加载模板中");
  const projectTitle = activeSession?.project_name || projectName || "未选择访谈";
  const customerTitle = activeSession?.customer_name || customerName || "未填写客户";
  const analysisReady = Boolean(prd && requirements.length);
  const transcriptReady = transcript.length > 0;
  const correctionReady = Boolean(correctedText.trim());
  const exportReady = Boolean(activeSession && (analysisReady || prd));
  const evidenceBackedCount = requirements.filter((item) => item.evidence_refs?.length).length;
  const confirmedEvidenceCount = requirements.filter((item) => item.evidence_refs?.[0]?.review_status === "confirmed").length;
  const lowConfidenceEvidenceCount = requirements.filter((item) => {
    const evidence = item.evidence_refs?.[0];
    return evidence && evidence.review_status === "unreviewed" && evidence.confidence < 0.6;
  }).length;
  const missingEvidenceCount = requirements.filter((item) => !item.evidence_refs?.length).length;
  const pendingCorrectionSuggestionCount = correctionSuggestions.filter((item) => item.status === "pending").length;
  const safePendingCorrectionCount = correctionSuggestions.filter(
    (item) => item.status === "pending" && item.safe_auto_apply,
  ).length;
  const appliedCorrectionSuggestionCount = correctionSuggestions.filter((item) =>
    ["auto_applied", "applied"].includes(item.status),
  ).length;
  const uncertainCorrectionSuggestionCount = correctionSuggestions.filter(
    (item) => item.status === "pending" && !item.safe_auto_apply,
  ).length;
  const analysisQuality = (() => {
    if (analysisStatus === "running" || pipelineStatus === "running") {
      return {
        label: "增强中",
        shortLabel: "Enhancing",
        tone: "running" as AnalysisQualityTone,
        detail: analysisMessage,
        engine: formatAnalysisEngine(analysisResult?.engine),
      };
    }
    if (!analysisResult) {
      return {
        label: analysisReady ? "未知来源" : "等待分析",
        shortLabel: analysisReady ? "Unknown" : "Not Ready",
        tone: analysisReady ? ("warn" as AnalysisQualityTone) : ("muted" as AnalysisQualityTone),
        detail: analysisReady ? "当前只加载到需求项，未读取到分析来源元数据。" : "生成转写后可抽取需求分析。",
        engine: "未记录模型",
      };
    }
    if (analysisResult.status === "completed") {
      return {
        label: "API 增强结果",
        shortLabel: "API Enhanced",
        tone: "ready" as AnalysisQualityTone,
        detail: analysisResult.message || "大模型增强分析已完成。",
        engine: formatAnalysisEngine(analysisResult.engine),
      };
    }
    return {
      label: "本地草稿",
      shortLabel: "Local Draft",
      tone: "warn" as AnalysisQualityTone,
      detail: analysisResult.message || "当前为本地规则抽取结果，适合快速预览，正式交付前建议运行 API 增强。",
      engine: formatAnalysisEngine(analysisResult.engine),
    };
  })();
  const fdeOsErrorCount = fdeOsValidation?.issues.filter((issue) => issue.severity === "error").length || 0;
  const fdeOsWarningCount = fdeOsValidation?.issues.filter((issue) => issue.severity === "warning").length || 0;
  const fdeOsReadiness = fdeOsValidation?.readiness_label;
  const fdeOsStatusLabel = fdeOsReadinessLabel(fdeOsReadiness);
  const fdeOsStatusTone = fdeOsReadinessTone(fdeOsReadiness);
  const fdeOsTopIssues = fdeOsValidation?.issues.slice(0, 3) || [];
  const stageStatusItems = [
    {
      label: "Gateway",
      value: health ? (health.ok ? "Connected" : "Disconnected") : "Connecting",
      tone: health ? (health.ok ? "ready" : "warn") : "muted",
    },
    {
      label: "ASR",
      value: health ? (health.transcription?.model_ready ? "Local Ready" : "Local Missing") : "Checking",
      tone: health ? (health.transcription?.model_ready ? "ready" : "warn") : "muted",
    },
    {
      label: "Transcript",
      value: activeSession ? (transcriptReady ? `${transcript.length} turns` : "Not Ready") : "Loading",
      tone: transcriptReady ? "ready" : "muted",
    },
    {
      label: "Analysis",
      value: activeSession ? analysisQuality.shortLabel : "Loading",
      tone: analysisQuality.tone,
    },
    {
      label: "FDE OS",
      value: activeSession ? fdeOsStatusLabel : "Loading",
      tone: fdeOsStatusTone,
    },
  ];
  const visibleModules = prd?.feature_modules.slice(0, 5) || [];
  const visibleMetrics = prd?.success_metrics.slice(0, 3) || [];
  const visibleQuestions = openQuestions.slice(0, 4);
  const visibleRisks = risks.slice(0, 2);
  const scriptedTemplateQuestions = useMemo<OpenQuestionItem[]>(
    () =>
      (activeTemplate?.required_questions || []).map((question, index) => ({
        id: `template_question:${activeTemplate?.id || "unknown"}:${index + 1}`,
        question,
        reason: "当前还没有分析补问，先按场景模板进行开场访谈。",
        owner_role: "FDE",
        created_at: "",
      })),
    [activeTemplate],
  );
  const questionQueue = openQuestions.length ? openQuestions : scriptedTemplateQuestions;
  const displayQuestions = questionQueue.slice(0, 6);
  const displayRisks = risks.slice(0, 4);
  const askedAgentQuestionIds = new Set(agentQuestionEvents.map((item) => item.question_id).filter(Boolean));
  const nextQuestion = displayQuestions.find((item) => !askedAgentQuestionIds.has(item.id)) || displayQuestions[0] || null;
  const nextQuestionAsked = Boolean(nextQuestion && askedAgentQuestionIds.has(nextQuestion.id));
  const questionQueueSourceLabel = openQuestions.length ? "分析补问" : "模板脚本";
  const selectedRequirement = requirements.find((item) => item.id === selectedRequirementId) || requirements[0] || null;
  const selectedEvidence = selectedRequirement?.evidence_refs?.[0] || null;
  const selectedEvidenceStatus = selectedEvidence?.review_status || "unreviewed";
  const selectedEvidenceReviewMeta = EVIDENCE_REVIEW_META[selectedEvidenceStatus];
  const selectedEvidenceSegment =
    transcriptSegments.find((segment) => segment.id === selectedEvidence?.transcript_segment_id) || null;
  const relocationSegment = transcriptSegments.find((segment) => segment.id === relocationSegmentId) || null;
  const activeReviewSegment = relocationSegment || selectedEvidenceSegment;
  const relocationChanged = Boolean(
    selectedEvidence && relocationSegmentId && relocationSegmentId !== selectedEvidence.transcript_segment_id,
  );
  const reviewTranscriptText = correctedText.trim() || transcript.map((turn) => turn.text).join("\n\n");
  const reviewTranscriptLabel = correctedText.trim() ? "转写校对稿" : transcript.length ? "原始转写" : "暂无转写";
  const privateTranscriptItems = correctedText.trim()
    ? [
        {
          id: correctedTranscript?.session_id || "corrected-transcript",
          label: `校对稿 · ${correctedTranscript ? formatDateTime(correctedTranscript.updated_at) : "已生成"}`,
          text: correctedText.trim(),
        },
      ]
    : transcript
        .slice(-4)
        .reverse()
        .map((turn) => ({
          id: turn.id,
          label: `${formatTimestamp(turn.start_ms)}-${formatTimestamp(turn.end_ms)}`,
          text: turn.text,
        }));
  const latestAgentQuestions = agentQuestionEvents.slice(-4).reverse();
  const persistedDisplayStatus = activeSession?.display_status || "standby";
  const sessionIsOnAir = activeSession?.status === "active" && persistedDisplayStatus === "on_air";
  const displayStatus: DisplayStatus =
    recordingStatus === "recording" || sessionIsOnAir
      ? "on_air"
      : persistedDisplayStatus === "on_air"
        ? "standby"
        : persistedDisplayStatus;
  const displayStatusMeta: Record<DisplayStatus, { text: string; subtext: string; label: string }> = {
    standby: { text: "STANDBY", subtext: "等待开始录音", label: "等待开始" },
    on_air: { text: "ON AIR", subtext: "访谈录音中", label: "访谈录音中" },
    processing: { text: "PROCESSING", subtext: "分析整理中", label: "分析整理中" },
  };
  const onAirText = displayStatusMeta[displayStatus].text;
  const onAirSubtext = displayStatusMeta[displayStatus].subtext;
  const isDisplayWindow = viewMode === "customer" || viewMode === "fde";
  const effectiveDisplayRole: DisplayRole | null = isDisplayWindow
    ? displayLayout.swapped
      ? viewMode === "customer"
        ? "fde"
        : "customer"
      : viewMode
    : null;
  const displaySlotLabel =
    viewMode === "customer" ? "客户窗口槽位" : viewMode === "fde" ? "FDE 窗口槽位" : "主控屏";
  const effectiveDisplayLabel =
    effectiveDisplayRole === "customer" ? "客户共识屏" : effectiveDisplayRole === "fde" ? "FDE 私有屏" : "主控屏";
  const otherDisplaySlot: DisplayRole = viewMode === "customer" ? "fde" : "customer";
  const otherDisplaySlotLabel = otherDisplaySlot === "customer" ? "客户槽位" : "FDE 槽位";
  const displayLayoutSavedLabel = displayLayout.saved_at ? formatDateTime(displayLayout.saved_at) : "未保存";
  const displayLayoutModeLabel = displayLayout.swapped ? "已交换" : "正常映射";
  const displayLayoutCalibrationLabel = displayLayout.calibration ? "校准中" : "未校准";

  function navigateView(mode: ViewMode) {
    const nextUrl = new URL(window.location.href);
    if (mode === "workspace") {
      nextUrl.searchParams.delete("view");
    } else {
      nextUrl.searchParams.set("view", mode);
    }
    if (activeSession?.id) {
      nextUrl.searchParams.set("session", activeSession.id);
    }
    window.history.pushState(null, "", nextUrl);
    setViewMode(mode);
  }

  function openDisplayMode(mode: "customer" | "fde") {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("view", mode);
    if (activeSession?.id) {
      nextUrl.searchParams.set("session", activeSession.id);
    }
    const bounds = displayLayout[mode];
    const features = [
      "popup=yes",
      `width=${Math.max(900, bounds?.outer_width || 1280)}`,
      `height=${Math.max(680, bounds?.outer_height || 820)}`,
      bounds ? `left=${bounds.screen_x}` : "",
      bounds ? `top=${bounds.screen_y}` : "",
    ]
      .filter(Boolean)
      .join(",");
    window.open(nextUrl.toString(), `fde-${mode}-display`, features);
  }

  function persistDisplayLayout(nextLayout: DisplayLayoutPreference, message: string) {
    setDisplayLayout(nextLayout);
    setDisplayLayoutMessage(message);
    try {
      localStorage.setItem(DISPLAY_LAYOUT_KEY, JSON.stringify(nextLayout));
    } catch {
      setDisplayLayoutMessage(`${message}（当前环境未能写入本机存储）`);
    }
  }

  function enterDisplayCalibration() {
    const nextLayout = {
      ...displayLayout,
      calibration: true,
      saved_at: new Date().toISOString(),
    };
    persistDisplayLayout(nextLayout, "已进入副屏校准模式，请把两个窗口拖到对应外接屏。");
    window.setTimeout(() => {
      openDisplayMode("fde");
      openDisplayMode("customer");
    }, 50);
  }

  function exitDisplayCalibration() {
    persistDisplayLayout(
      {
        ...displayLayout,
        calibration: false,
        saved_at: new Date().toISOString(),
      },
      "已退出副屏校准模式。",
    );
  }

  function swapDisplayRoles() {
    persistDisplayLayout(
      {
        ...displayLayout,
        swapped: !displayLayout.swapped,
        saved_at: new Date().toISOString(),
      },
      !displayLayout.swapped ? "已交换：客户窗口槽位显示 FDE 屏，FDE 窗口槽位显示客户屏。" : "已恢复：窗口槽位与显示角色一致。",
    );
  }

  function saveDisplayLayout() {
    const customerBounds = readDisplayWindowBounds("customer") || displayLayout.customer;
    const fdeBounds = readDisplayWindowBounds("fde") || displayLayout.fde;
    persistDisplayLayout(
      {
        ...displayLayout,
        customer: customerBounds,
        fde: fdeBounds,
        saved_at: new Date().toISOString(),
      },
      customerBounds || fdeBounds
        ? "已保存本机副屏布局，下次打开将优先恢复窗口位置。"
        : "已保存本机副屏角色偏好；还未捕获到副屏窗口位置。",
    );
  }

  async function updateDisplayStatus(nextStatus: DisplayStatus) {
    if (!activeSession) {
      setError("请先创建或选择一个访谈 session。");
      return;
    }
    if (nextStatus === "on_air" && recordingStatus !== "recording" && !sessionIsOnAir) {
      setError("ON AIR 只在真实录音开始后自动进入。请点击“开始录音”。");
      return;
    }
    setError("");
    setDisplayStatusBusy(true);
    try {
      const updated = await fetchJson<Session>(`/sessions/${activeSession.id}/display-status`, {
        method: "PATCH",
        body: JSON.stringify({ display_status: nextStatus }),
      });
      setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
      setActiveSessionId(updated.id);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : String(statusError));
    } finally {
      setDisplayStatusBusy(false);
    }
  }

  async function refresh() {
    setError("");
    try {
      const [nextHealth, nextTemplates, nextSessions] = await Promise.all([
        fetchJson<Health>("/health"),
        fetchJson<Template[]>("/templates"),
        fetchJson<Session[]>("/sessions"),
      ]);
      setHealth(nextHealth);
      setTemplates(nextTemplates);
      setSessions(nextSessions);
      const requestedSessionId = readSessionIdFromUrl();
      const activeStillExists = nextSessions.some((session) => session.id === activeSessionId);
      if ((!activeSessionId || !activeStillExists) && nextSessions.length) {
        setActiveSessionId(
          nextSessions.find((session) => session.id === requestedSessionId)?.id ||
            nextSessions.find((session) => session.id === DEMO_SESSION_ID)?.id ||
            nextSessions[0].id,
        );
      }
      if (!templateId && nextTemplates.length) {
        setTemplateId(nextTemplates.find((template) => template.id === DEMO_TEMPLATE_ID)?.id || nextTemplates[0].id);
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }

  async function createSession() {
    setBusy(true);
    setError("");
    try {
      const session = await fetchJson<Session>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          project_name: projectName,
          customer_name: customerName,
          template_id: templateId,
          mode,
        }),
      });
      setActiveSessionId(session.id);
      await refresh();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  }

  async function createWritableSessionFromCurrent() {
    if (!activeSession) {
      setError("请先选择一个访谈 session。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const session = await fetchJson<Session>("/sessions", {
        method: "POST",
        body: JSON.stringify({
          project_name: `${activeSession.project_name} - 现场访谈`,
          customer_name: activeSession.customer_name,
          template_id: activeSession.template_id,
          mode: activeSession.mode,
        }),
      });
      setProjectName(session.project_name);
      setCustomerName(session.customer_name);
      setTemplateId(session.template_id);
      setMode(session.mode);
      setActiveSessionId(session.id);
      setRecordingMessage("已创建可录音工作副本，可以开始现场录音。");
      await refresh();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  }

  async function loadTranscript(sessionId: string) {
    if (!sessionId) {
      setTranscript([]);
      setTranscriptSegments([]);
      setCorrectedTranscript(null);
      setCorrectedText("");
      setCorrectionSuggestions([]);
      return;
    }
    const [turns, corrected, segments, suggestions] = await Promise.all([
      fetchJson<TranscriptTurn[]>(`/sessions/${sessionId}/transcript`),
      fetchJson<CorrectedTranscript>(`/sessions/${sessionId}/transcript/corrected`),
      fetchJson<TranscriptSegment[]>(`/sessions/${sessionId}/transcript/segments`),
      fetchJson<TranscriptCorrectionSuggestion[]>(`/sessions/${sessionId}/transcript/correction-suggestions`),
    ]);
    setTranscript(turns);
    setTranscriptSegments(segments);
    setCorrectedTranscript(corrected);
    setCorrectedText(corrected.corrected_text);
    setCorrectionSuggestions(suggestions);
  }

  async function loadAnalysis(sessionId: string) {
    if (!sessionId) {
      setRequirements([]);
      setRisks([]);
      setOpenQuestions([]);
      setPrd(null);
      setAnalysisResult(null);
      return;
    }
    const [nextAnalysis, nextRequirements, nextRisks, nextQuestions] = await Promise.all([
      fetchJson<AnalysisResult>(`/sessions/${sessionId}/analysis`),
      fetchJson<RequirementItem[]>(`/sessions/${sessionId}/requirements`),
      fetchJson<RiskItem[]>(`/sessions/${sessionId}/risks`),
      fetchJson<OpenQuestionItem[]>(`/sessions/${sessionId}/open-questions`),
    ]);
    setAnalysisResult(nextAnalysis);
    setPrd(nextAnalysis.prd);
    setRequirements(nextRequirements);
    setRisks(nextRisks);
    setOpenQuestions(nextQuestions);
  }

  async function loadFdeOsValidation(sessionId: string) {
    if (!sessionId) {
      setFdeOsValidation(null);
      setFdeOsValidationMessage("未选择访谈 session。");
      return;
    }
    const result = await fetchJson<FdeOsBundleValidationResult>(`/sessions/${sessionId}/fde-os/bundle/validation`);
    setFdeOsValidation(result);
    setFdeOsValidationMessage(
      result.import_ready
        ? "对象包结构可导入 FDE OS；警告项会作为项目质检待办保留。"
        : "对象包仍有阻塞项，暂不建议导入 FDE OS。",
    );
  }

  async function loadAudioAsset(sessionId: string) {
    if (!sessionId) {
      setAudioAsset(null);
      return;
    }
    const asset = await fetchJson<AudioAsset>(`/sessions/${sessionId}/audio`);
    setAudioAsset(asset);
    setAudioPlayback("idle");
  }

  async function loadAgentQuestionEvents(sessionId: string) {
    if (!sessionId) {
      setAgentQuestionEvents([]);
      return;
    }
    const events = await fetchJson<AgentQuestionEvent[]>(`/sessions/${sessionId}/agent/questions`);
    setAgentQuestionEvents(events);
  }

  async function runOfflineAsr() {
    if (!activeSession) {
      setError("请先创建或选择一个访谈 session。");
      return;
    }
    setError("");
    setAsrStatus("running");
    setAsrMessage("正在读取 raw.wav 并生成转写...");
    try {
      const result = await fetchJson<RunAsrResponse>(`/sessions/${activeSession.id}/asr/offline`, {
        method: "POST",
      });
      setTranscript(result.transcript);
      setAsrMessage(result.message);
      const corrected = await fetchJson<CorrectedTranscript>(`/sessions/${activeSession.id}/transcript/normalize`, {
        method: "POST",
      });
      setCorrectedTranscript(corrected);
      setCorrectedText(corrected.corrected_text);
      setCorrectionMessage(`已生成纠错稿：${corrected.corrections.length} 条术语替换。`);
      await loadTranscript(activeSession.id);
      await loadFdeOsValidation(activeSession.id);
      await loadFdeOsValidation(activeSession.id);
      await refresh();
    } catch (asrError) {
      setError(asrError instanceof Error ? asrError.message : String(asrError));
    } finally {
      setAsrStatus("idle");
    }
  }

  async function extractAnalysis() {
    if (!activeSession) {
      setError("请先创建或选择一个访谈 session。");
      return;
    }
    setError("");
    setAnalysisStatus("running");
    setAnalysisMessage("已提交后台分析任务...");
    try {
      const job = await fetchJson<AnalysisJobResponse>(`/sessions/${activeSession.id}/analysis/jobs`, {
        method: "POST",
      });
      const result = await pollAnalysisJob(job.job_id);
      if (!result.analysis) {
        throw new Error(result.message || "Analysis job completed without analysis result.");
      }
      setRequirements(result.analysis.requirements);
      setRisks(result.analysis.risks);
      setOpenQuestions(result.analysis.open_questions);
      setPrd(result.analysis.prd);
      setAnalysisResult(result.analysis);
      setAnalysisMessage(result.message);
      if (result.markdown) {
        setExportMessage(`需求分析已导出：${result.markdown.path}`);
      }
      await loadFdeOsValidation(activeSession.id);
      await refresh();
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : String(analysisError));
    } finally {
      setAnalysisStatus("idle");
    }
  }

  async function pollAnalysisJob(jobId: string): Promise<AnalysisJobResponse> {
    let latestJob: AnalysisJobResponse | null = null;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const job = await fetchJson<AnalysisJobResponse>(`/analysis/jobs/${jobId}`);
      setAnalysisMessage(`${job.status}: ${job.message}`);
      if (job.analysis && job.analysis !== latestJob?.analysis) {
        setRequirements(job.analysis.requirements);
        setRisks(job.analysis.risks);
        setOpenQuestions(job.analysis.open_questions);
        setPrd(job.analysis.prd);
        setAnalysisResult(job.analysis);
      }
      if (job.markdown) {
        setExportMessage(`需求分析已导出：${job.markdown.path}`);
      }
      latestJob = job;
      if (job.status === "completed") {
        return job;
      }
      if (job.status === "failed") {
        throw new Error(job.message);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error("后台分析任务超时。");
  }

  async function normalizeTranscript() {
    if (!activeSession) {
      setError("请先创建或选择一个访谈 session。");
      return;
    }
    setError("");
    setCorrectionStatus("running");
    setCorrectionMessage("正在生成纠错稿...");
    try {
      const corrected = await fetchJson<CorrectedTranscript>(`/sessions/${activeSession.id}/transcript/normalize`, {
        method: "POST",
      });
      setCorrectedTranscript(corrected);
      setCorrectedText(corrected.corrected_text);
      setCorrectionMessage(`已生成纠错稿：${corrected.corrections.length} 条术语替换。`);
      await loadTranscript(activeSession.id);
    } catch (correctionError) {
      setError(correctionError instanceof Error ? correctionError.message : String(correctionError));
    } finally {
      setCorrectionStatus("idle");
    }
  }

  async function saveCorrectedTranscript() {
    if (!activeSession || !correctedText.trim()) {
      return;
    }
    setError("");
    setCorrectionStatus("saving");
    setCorrectionMessage("正在保存人工校对...");
    try {
      const corrected = await fetchJson<CorrectedTranscript>(`/sessions/${activeSession.id}/transcript/corrected`, {
        method: "PUT",
        body: JSON.stringify({ corrected_text: correctedText }),
      });
      setCorrectedTranscript(corrected);
      setCorrectedText(corrected.corrected_text);
      setCorrectionMessage("已保存人工校对，后续分析会优先使用纠错稿。");
      await loadTranscript(activeSession.id);
      await loadFdeOsValidation(activeSession.id);
    } catch (correctionError) {
      setError(correctionError instanceof Error ? correctionError.message : String(correctionError));
    } finally {
      setCorrectionStatus("idle");
    }
  }

  async function scanCorrectionSuggestions(autoApply: boolean) {
    if (!activeSession) {
      setError("请先创建或选择一个访谈 session。");
      return;
    }
    setError("");
    setSuggestionBusy(autoApply ? "auto" : "scan");
    setCorrectionMessage(autoApply ? "正在扫描并自动应用高置信错词..." : "正在扫描转写错词候选...");
    try {
      const suggestions = await fetchJson<TranscriptCorrectionSuggestion[]>(
        `/sessions/${activeSession.id}/transcript/correction-suggestions/scan?auto_apply=${autoApply ? "true" : "false"}`,
        { method: "POST" },
      );
      setCorrectionSuggestions(suggestions);
      await loadTranscript(activeSession.id);
      const pendingCount = suggestions.filter((item) => item.status === "pending").length;
      const appliedCount = suggestions.filter((item) => ["auto_applied", "applied"].includes(item.status)).length;
      setCorrectionMessage(`已扫描错词候选：待确认 ${pendingCount} 条，已应用 ${appliedCount} 条。`);
      await loadFdeOsValidation(activeSession.id);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      setSuggestionBusy("");
    }
  }

  async function updateCorrectionSuggestion(item: TranscriptCorrectionSuggestion, action: "apply" | "ignore") {
    if (!activeSession) {
      setError("请先创建或选择一个访谈 session。");
      return;
    }
    setError("");
    setSuggestionBusy(`${action}:${item.id}`);
    try {
      const suggestions = await fetchJson<TranscriptCorrectionSuggestion[]>(
        `/sessions/${activeSession.id}/transcript/correction-suggestions/${item.id}`,
        {
          method: "POST",
          body: JSON.stringify({ action }),
        },
      );
      setCorrectionSuggestions(suggestions);
      await loadTranscript(activeSession.id);
      setCorrectionMessage(
        action === "apply"
          ? `已应用纠错：${item.wrong_text} -> ${item.suggested_text}。`
          : `已忽略纠错候选：${item.wrong_text}。`,
      );
      await loadFdeOsValidation(activeSession.id);
    } catch (suggestionError) {
      setError(suggestionError instanceof Error ? suggestionError.message : String(suggestionError));
    } finally {
      setSuggestionBusy("");
    }
  }

  async function exportArtifact(kind: "requirements-analysis" | "prd" | "fde-os-bundle" | "fde-os-store-patch") {
    if (!activeSession) {
      setError("请先创建或选择一个访谈 session。");
      return;
    }
    const label =
      kind === "prd"
        ? "PRD"
        : kind === "fde-os-bundle"
          ? "FDE OS 对象包"
          : kind === "fde-os-store-patch"
            ? "FDE OS 落库补丁"
            : "需求分析";
    setError("");
    setExportStatus("running");
    setExportMessage(`正在生成${label}...`);
    try {
      const result = await fetchJson<MarkdownExportResponse>(`/sessions/${activeSession.id}/exports/${kind}`, {
        method: "POST",
      });
      setExportMessage(`${label}已导出：${result.path}`);
      await loadFdeOsValidation(activeSession.id);
      window.open(`${API_BASE}/sessions/${activeSession.id}/exports/${kind}`, "_blank");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExportStatus("idle");
    }
  }

  function exportRequirementsAnalysis() {
    exportArtifact("requirements-analysis");
  }

  function exportPrd() {
    exportArtifact("prd");
  }

  function exportFdeOsBundle() {
    exportArtifact("fde-os-bundle");
  }

  function exportFdeOsStorePatch() {
    exportArtifact("fde-os-store-patch");
  }

  async function processSession() {
    if (!activeSession) {
      setError("请先创建或选择一个访谈 session。");
      return;
    }
    setError("");
    setPipelineStatus("running");
    setAsrMessage("一键处理中：正在生成转写...");
    setAnalysisMessage("一键处理中：等待后台分析...");
      setExportMessage("一键处理中：等待需求分析导出...");
    try {
      const asrResult = await fetchJson<RunAsrResponse>(`/sessions/${activeSession.id}/asr/offline`, {
        method: "POST",
      });
      setTranscript(asrResult.transcript);
      setAsrMessage(asrResult.message);
      const corrected = await fetchJson<CorrectedTranscript>(`/sessions/${activeSession.id}/transcript/normalize`, {
        method: "POST",
      });
      setCorrectedTranscript(corrected);
      setCorrectedText(corrected.corrected_text);
      setCorrectionMessage(`已生成纠错稿：${corrected.corrections.length} 条术语替换。`);
      await loadTranscript(activeSession.id);
      const job = await fetchJson<AnalysisJobResponse>(`/sessions/${activeSession.id}/analysis/jobs`, {
        method: "POST",
      });
      const result = await pollAnalysisJob(job.job_id);
      if (!result.analysis || !result.markdown) {
        throw new Error(result.message || "Pipeline completed without result.");
      }
      setRequirements(result.analysis.requirements);
      setRisks(result.analysis.risks);
      setOpenQuestions(result.analysis.open_questions);
      setPrd(result.analysis.prd);
      setAnalysisResult(result.analysis);
      setAnalysisMessage(result.message);
      setExportMessage(`需求分析已导出：${result.markdown.path}`);
      await loadFdeOsValidation(activeSession.id);
      window.open(`${API_BASE}/sessions/${activeSession.id}/exports/requirements-analysis`, "_blank");
      await refresh();
    } catch (pipelineError) {
      setError(pipelineError instanceof Error ? pipelineError.message : String(pipelineError));
    } finally {
      setPipelineStatus("idle");
    }
  }

  async function startRecording() {
    if (!activeSession) {
      setError("请先创建或选择一个访谈 session。");
      return;
    }
    setError("");
    let nextRecorder: RecorderState | null = null;
    const autoQuestion = questionDeliveryMode === "tts" && autoReadFirstQuestion ? nextQuestion : null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: questionDeliveryMode === "fde",
          noiseSuppression: questionDeliveryMode === "fde",
          autoGainControl: true,
        },
      });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextClass();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      nextRecorder = {
        audioContext,
        processor,
        source,
        stream,
        chunks,
        inputSampleRate: audioContext.sampleRate,
      };
      const updated = await fetchJson<Session>(`/sessions/${activeSession.id}/start`, { method: "POST" });
      recorderRef.current = nextRecorder;
      setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
      playRecordingCue(audioContext, "开始录音");
      setRecordingStatus("recording");
      setRecordingMessage(
        questionDeliveryMode === "tts"
          ? `正在录音：${activeSession.project_name}（TTS 发问模式，建议外放以进入整段录音）`
          : `正在录音：${activeSession.project_name}（FDE 本人发问）`,
      );
      if (autoQuestion) {
        window.setTimeout(() => {
          if (!recorderRef.current) {
            return;
          }
          void speakQuestion(autoQuestion, "auto_opening_question");
        }, 1200);
      }
      await refresh();
    } catch (recordError) {
      if (nextRecorder) {
        nextRecorder.processor.disconnect();
        nextRecorder.source.disconnect();
        nextRecorder.stream.getTracks().forEach((track) => track.stop());
        await nextRecorder.audioContext.close().catch(() => undefined);
      }
      setError(recordError instanceof Error ? recordError.message : String(recordError));
      setRecordingStatus("idle");
    }
  }

  async function discardCurrentRecording() {
    const recorder = recorderRef.current;
    if (!recorder || !activeSession) {
      return;
    }
    const shouldDiscard = window.confirm("放弃本次录音？当前未保存的录音内容不会写入 raw.wav。");
    if (!shouldDiscard) {
      return;
    }
    try {
      recorder.processor.disconnect();
      recorder.source.disconnect();
      recorder.stream.getTracks().forEach((track) => track.stop());
      await recorder.audioContext.close();
      recorderRef.current = null;
      await fetchJson<Session>(`/sessions/${activeSession.id}/pause`, { method: "POST" });
      setRecordingStatus("idle");
      setRecordingMessage("已放弃本次录音，未保存 raw.wav。");
      await refresh();
    } catch (discardError) {
      setError(discardError instanceof Error ? discardError.message : String(discardError));
      setRecordingStatus("idle");
    }
  }

  async function deleteCurrentSession() {
    if (!activeSession) {
      setError("请先选择一个访谈 session。");
      return;
    }
    const shouldDelete = window.confirm(`删除当前访谈「${activeSession.project_name}」？该 session 的录音、转写、分析和导出都会删除。`);
    if (!shouldDelete) {
      return;
    }
    setError("");
    try {
      await fetchJson<void>(`/sessions/${activeSession.id}`, { method: "DELETE" });
      setActiveSessionId("");
      setAudioAsset(null);
      setTranscript([]);
      setTranscriptSegments([]);
      setCorrectedTranscript(null);
      setCorrectedText("");
      setCorrectionSuggestions([]);
      setRequirements([]);
      setRisks([]);
      setOpenQuestions([]);
      setPrd(null);
      setRecordingMessage("当前访谈已删除。");
      await refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function stopRecordingAndUpload() {
    const recorder = recorderRef.current;
    if (!recorder || !activeSession) {
      return;
    }
    setRecordingStatus("uploading");
    setRecordingMessage("正在编码并上传 raw.wav...");
    try {
      recorder.processor.disconnect();
      recorder.source.disconnect();
      recorder.stream.getTracks().forEach((track) => track.stop());
      await recorder.audioContext.close();
      recorderRef.current = null;

      const merged = mergeFloat32Chunks(recorder.chunks);
      const downsampled = downsampleBuffer(merged, recorder.inputSampleRate, 16000);
      const wavBlob = encodeWav(downsampled, 16000);
      await uploadRawWav(activeSession.id, wavBlob);
      await fetchJson<Session>(`/sessions/${activeSession.id}/stop`, { method: "POST" });
      playRecordingCue(null, "录音已保存");
      setRecordingStatus("idle");
      setRecordingMessage(`已保存 raw.wav，大小 ${(wavBlob.size / 1024).toFixed(1)} KB。`);
      await loadAudioAsset(activeSession.id);
      await loadFdeOsValidation(activeSession.id);
      await refresh();
    } catch (recordError) {
      setError(recordError instanceof Error ? recordError.message : String(recordError));
      setRecordingStatus("idle");
    }
  }

  function playRecordingCue(audioContext: AudioContext | null, text: string) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const context = audioContext || new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(text === "开始录音" ? 880 : 660, context.currentTime);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.24);
      if (!audioContext) {
        window.setTimeout(() => context.close().catch(() => undefined), 360);
      }
    } catch {
      // Audible cue is best effort; recording must not fail if audio output is blocked.
    }
    if ("speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined") {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "zh-CN";
      utterance.rate = 1.05;
      utterance.volume = 1;
      window.speechSynthesis.speak(utterance);
    }
  }

  async function playAudioAsset() {
    if (!audioRef.current) {
      return;
    }
    await audioRef.current.play();
    setAudioPlayback("playing");
  }

  function pauseAudioAsset() {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.pause();
    setAudioPlayback("paused");
  }

  async function playEvidenceSegment(evidence: EvidenceReference) {
    await playAudioRange(evidence.start_ms, evidence.end_ms);
  }

  async function playAudioRange(startMs: number, endMs: number) {
    const player = reviewAudioRef.current || audioRef.current;
    if (!player) {
      setError("当前没有可播放的 raw.wav 音频。");
      return;
    }
    if (segmentStopTimerRef.current) {
      window.clearTimeout(segmentStopTimerRef.current);
      segmentStopTimerRef.current = null;
    }
    player.currentTime = Math.max(0, startMs / 1000);
    await player.play();
    setAudioPlayback("playing");
    const durationMs = Math.max(1000, endMs - startMs);
    segmentStopTimerRef.current = window.setTimeout(() => {
      player.pause();
      player.currentTime = Math.max(0, endMs / 1000);
      setAudioPlayback("paused");
      segmentStopTimerRef.current = null;
    }, durationMs + 300);
  }

  async function updateEvidenceReviewStatus(status: EvidenceReviewStatus) {
    if (!activeSession || !selectedRequirement || !selectedEvidence) {
      setError("请先选择一个已定位证据的需求项。");
      return;
    }
    setError("");
    setEvidenceReviewBusy(true);
    try {
      const updated = await fetchJson<RequirementItem>(
        `/sessions/${activeSession.id}/requirements/${selectedRequirement.id}/evidence/${selectedEvidence.id}/review`,
        {
          method: "PATCH",
          body: JSON.stringify({
            review_status: status,
            review_note: status === "unreviewed" ? "" : evidenceReviewNote,
          }),
        },
      );
      setRequirements((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelectedRequirementId(updated.id);
      setEvidenceReviewNote(updated.evidence_refs[0]?.review_note || "");
      setExportMessage("证据复核状态已更新，后续需求分析和 PRD 导出会带上该状态。");
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    } finally {
      setEvidenceReviewBusy(false);
    }
  }

  async function relocateEvidenceToSegment() {
    if (!activeSession || !selectedRequirement || !selectedEvidence || !relocationSegment) {
      setError("请先选择一个需求项和新的转写片段。");
      return;
    }
    setError("");
    setEvidenceRelocationBusy(true);
    try {
      const note = evidenceReviewNote.trim() || `人工重定位到 ${relocationSegment.id}`;
      const updated = await fetchJson<RequirementItem>(
        `/sessions/${activeSession.id}/requirements/${selectedRequirement.id}/evidence/${selectedEvidence.id}/relocate`,
        {
          method: "PATCH",
          body: JSON.stringify({
            transcript_segment_id: relocationSegment.id,
            review_status: "confirmed",
            review_note: note,
          }),
        },
      );
      setRequirements((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSelectedRequirementId(updated.id);
      setEvidenceReviewNote(updated.evidence_refs[0]?.review_note || "");
      setRelocationSegmentId(updated.evidence_refs[0]?.transcript_segment_id || "");
      setExportMessage("证据已人工重定位并标记为已确认，后续导出会使用新的片段和时间点。");
    } catch (relocationError) {
      setError(relocationError instanceof Error ? relocationError.message : String(relocationError));
    } finally {
      setEvidenceRelocationBusy(false);
    }
  }

  async function updateTurnSpeaker(turn: TranscriptTurn, speaker: SpeakerRole) {
    if (!activeSession || turn.speaker === speaker) {
      return;
    }
    setError("");
    setSpeakerUpdateId(turn.id);
    try {
      const updated = await fetchJson<TranscriptTurn>(
        `/sessions/${activeSession.id}/transcript/turns/${turn.id}/speaker`,
        {
          method: "PATCH",
          body: JSON.stringify({ speaker }),
        },
      );
      setTranscript((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      await loadTranscript(activeSession.id);
      setCorrectionMessage("说话人标注已保存，证据片段会继承该边界。");
    } catch (speakerError) {
      setError(speakerError instanceof Error ? speakerError.message : String(speakerError));
    } finally {
      setSpeakerUpdateId("");
    }
  }

  async function updateSegmentSpeaker(segment: TranscriptSegment, speaker: SpeakerRole) {
    if (!activeSession || segment.speaker === speaker) {
      return;
    }
    setError("");
    setSpeakerUpdateId(segment.id);
    try {
      const updated = await fetchJson<TranscriptSegment>(
        `/sessions/${activeSession.id}/transcript/segments/${segment.id}/speaker`,
        {
          method: "PATCH",
          body: JSON.stringify({ speaker }),
        },
      );
      setTranscriptSegments((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setCorrectionMessage("片段说话人边界已保存，后续证据复核会使用该标注。");
    } catch (speakerError) {
      setError(speakerError instanceof Error ? speakerError.message : String(speakerError));
    } finally {
      setSpeakerUpdateId("");
    }
  }

  function segmentEditorValues() {
    const startMs = Math.round(Number(segmentEditStartMs));
    const endMs = Math.round(Number(segmentEditEndMs));
    const splitMs = Math.round(Number(segmentEditSplitMs));
    return { startMs, endMs, splitMs };
  }

  function setSegmentEditorRange(startMs: number, endMs: number, splitMs = Math.round((startMs + endMs) / 2)) {
    setSegmentEditStartMs(String(Math.max(0, Math.round(startMs))));
    setSegmentEditEndMs(String(Math.max(0, Math.round(endMs))));
    setSegmentEditSplitMs(String(Math.max(0, Math.round(splitMs))));
  }

  function nudgeSegmentTime(field: "start" | "end" | "split", deltaMs: number) {
    const { startMs, endMs, splitMs } = segmentEditorValues();
    const durationLimit = audioAsset?.duration_ms || Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(splitMs)) {
      setError("当前片段时间不是有效数字。");
      return;
    }
    const minGap = 250;
    const clampSplit = (value: number, nextStart: number, nextEnd: number) =>
      Math.max(nextStart + minGap, Math.min(value, nextEnd - minGap));
    if (field === "start") {
      const nextStart = Math.max(0, Math.min(startMs + deltaMs, endMs - minGap));
      setSegmentEditorRange(nextStart, endMs, clampSplit(splitMs + deltaMs, nextStart, endMs));
      return;
    }
    if (field === "end") {
      const nextEnd = Math.min(durationLimit, Math.max(endMs + deltaMs, startMs + minGap));
      setSegmentEditorRange(startMs, nextEnd, clampSplit(splitMs + deltaMs, startMs, nextEnd));
      return;
    }
    const nextSplit = clampSplit(splitMs + deltaMs, startMs, endMs);
    setSegmentEditSplitMs(String(Math.round(nextSplit)));
  }

  async function playSegmentDraft() {
    const { startMs, endMs } = segmentEditorValues();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      setError("片段结束时间必须大于开始时间。");
      return;
    }
    await playAudioRange(startMs, endMs);
  }

  function segmentTimelineMetrics(segment: TranscriptSegment) {
    const duration = audioAsset?.duration_ms || Math.max(segment.end_ms, 1);
    const { startMs, endMs, splitMs } = segmentEditorValues();
    const safeStart = Number.isFinite(startMs) ? startMs : segment.start_ms;
    const safeEnd = Number.isFinite(endMs) ? endMs : segment.end_ms;
    const safeSplit = Number.isFinite(splitMs) ? splitMs : Math.round((safeStart + safeEnd) / 2);
    const left = Math.max(0, Math.min(100, (safeStart / duration) * 100));
    const right = Math.max(0, Math.min(100, (safeEnd / duration) * 100));
    const split = Math.max(0, Math.min(100, (safeSplit / duration) * 100));
    return {
      rangeStyle: { left: `${left}%`, width: `${Math.max(0.6, right - left)}%` },
      splitStyle: { left: `${split}%` },
      draftDurationMs: Math.max(0, safeEnd - safeStart),
    };
  }

  async function saveSegmentBoundary(segment: TranscriptSegment) {
    if (!activeSession) {
      setError("请先选择一个访谈 session。");
      return;
    }
    const { startMs, endMs } = segmentEditorValues();
    const nextText = segmentEditText.trim();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      setError("片段结束时间必须大于开始时间。");
      return;
    }
    if (!nextText) {
      setError("片段文本不能为空。");
      return;
    }
    setError("");
    setSegmentEditBusy(true);
    try {
      const segments = await fetchJson<TranscriptSegment[]>(
        `/sessions/${activeSession.id}/transcript/segments/${segment.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            start_ms: startMs,
            end_ms: endMs,
            text: nextText,
            corrected_text: segment.corrected_text ? nextText : "",
          }),
        },
      );
      setTranscriptSegments(segments);
      setRelocationSegmentId(segment.id);
      await loadAnalysis(activeSession.id);
      setExportMessage("转写片段边界已保存，关联证据时间点会同步更新。");
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : String(editError));
    } finally {
      setSegmentEditBusy(false);
    }
  }

  async function splitSegment(segment: TranscriptSegment) {
    if (!activeSession) {
      setError("请先选择一个访谈 session。");
      return;
    }
    const { splitMs } = segmentEditorValues();
    if (!Number.isFinite(splitMs) || splitMs <= segment.start_ms || splitMs >= segment.end_ms) {
      setError("拆分点必须位于当前片段的开始和结束时间之间。");
      return;
    }
    setError("");
    setSegmentEditBusy(true);
    try {
      const segments = await fetchJson<TranscriptSegment[]>(
        `/sessions/${activeSession.id}/transcript/segments/${segment.id}/split`,
        {
          method: "POST",
          body: JSON.stringify({ split_ms: splitMs }),
        },
      );
      setTranscriptSegments(segments);
      setRelocationSegmentId(segment.id);
      await loadAnalysis(activeSession.id);
      setExportMessage("转写片段已拆分，需求证据仍保留在原片段上。");
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : String(editError));
    } finally {
      setSegmentEditBusy(false);
    }
  }

  async function mergeSegmentWithNext(segment: TranscriptSegment) {
    if (!activeSession) {
      setError("请先选择一个访谈 session。");
      return;
    }
    setError("");
    setSegmentEditBusy(true);
    try {
      const segments = await fetchJson<TranscriptSegment[]>(
        `/sessions/${activeSession.id}/transcript/segments/${segment.id}/merge-next`,
        {
          method: "POST",
        },
      );
      setTranscriptSegments(segments);
      setRelocationSegmentId(segment.id);
      await loadAnalysis(activeSession.id);
      setExportMessage("转写片段已与下一段合并，关联证据已同步到合并后片段。");
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : String(editError));
    } finally {
      setSegmentEditBusy(false);
    }
  }

  async function recordQuestionEvent(item: OpenQuestionItem, source: string): Promise<AgentQuestionEvent | null> {
    if (!activeSession) {
      setError("请先选择一个访谈 session。");
      return null;
    }
    setError("");
    try {
      const event = await fetchJson<AgentQuestionEvent>(`/sessions/${activeSession.id}/agent/questions`, {
        method: "POST",
        body: JSON.stringify({
          question_id: item.id,
          question: item.question,
          reason: item.reason,
          owner_role: item.owner_role,
          source,
        }),
      });
      await loadAgentQuestionEvents(activeSession.id);
      return event;
    } catch (eventError) {
      setError(eventError instanceof Error ? eventError.message : String(eventError));
      return null;
    }
  }

  async function speakQuestion(item: OpenQuestionItem, source = "open_question") {
    if (!activeSession) {
      setError("请先选择一个访谈 session。");
      return;
    }
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setError("当前浏览器不支持本地语音合成。");
      return;
    }
    window.speechSynthesis.cancel();
    setError("");
    setTtsStatus("speaking");
    setCurrentTtsQuestionId(item.id);
    await recordQuestionEvent(item, source);
    setRecordingMessage(`正在朗读：${item.question}`);
    const utterance = new SpeechSynthesisUtterance(item.question);
    utterance.lang = "zh-CN";
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.onend = () => {
      setTtsStatus("idle");
      setCurrentTtsQuestionId("");
      setRecordingMessage(`已朗读：${item.question}`);
    };
    utterance.onerror = () => {
      setTtsStatus("idle");
      setCurrentTtsQuestionId("");
      setRecordingMessage("TTS 朗读失败，请切换为 FDE 本人发问或重试。");
    };
    window.speechSynthesis.speak(utterance);
  }

  function askQuestion(item: OpenQuestionItem, source = "open_question") {
    if (questionDeliveryMode === "tts") {
      void speakQuestion(item, source);
      return;
    }
    void recordQuestionEvent(item, "fde_manual");
    setRecordingMessage(`已标记 FDE 本人发问：${item.question}`);
  }

  function askNextQuestion() {
    if (!nextQuestion) {
      setError("当前没有可发问的补问问题。");
      return;
    }
    askQuestion(nextQuestion, questionDeliveryMode === "tts" ? "next_question" : "fde_manual");
  }

  function skipNextQuestion() {
    if (!nextQuestion) {
      setError("当前没有可跳过的补问问题。");
      return;
    }
    void recordQuestionEvent(nextQuestion, "skipped");
    setRecordingMessage(`已跳过：${nextQuestion.question}`);
  }

  function pauseTts() {
    if (!("speechSynthesis" in window)) {
      return;
    }
    window.speechSynthesis.pause();
    setTtsStatus("paused");
  }

  function resumeTts() {
    if (!("speechSynthesis" in window)) {
      return;
    }
    window.speechSynthesis.resume();
    setTtsStatus("speaking");
  }

  function stopTts() {
    if (!("speechSynthesis" in window)) {
      return;
    }
    window.speechSynthesis.cancel();
    setTtsStatus("idle");
    setCurrentTtsQuestionId("");
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(QUESTION_DELIVERY_MODE_KEY, questionDeliveryMode);
    } catch {
      // Ignore localStorage failures in restricted browser contexts.
    }
  }, [questionDeliveryMode]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_READ_FIRST_QUESTION_KEY, autoReadFirstQuestion ? "true" : "false");
    } catch {
      // Ignore localStorage failures in restricted browser contexts.
    }
  }, [autoReadFirstQuestion]);

  useEffect(() => {
    const onPopState = () => {
      setViewMode(readViewMode());
      const sessionFromUrl = readSessionIdFromUrl();
      if (sessionFromUrl) {
        setActiveSessionId(sessionFromUrl);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === QUESTION_DELIVERY_MODE_KEY) {
        setQuestionDeliveryMode(event.newValue === "fde" ? "fde" : "tts");
      }
      if (event.key === DISPLAY_LAYOUT_KEY) {
        setDisplayLayout(readDisplayLayoutPreference());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!isDisplayWindow || (viewMode !== "customer" && viewMode !== "fde")) {
      return undefined;
    }
    const writeBounds = () => writeDisplayWindowBounds(viewMode);
    writeBounds();
    const timer = window.setInterval(writeBounds, 2000);
    window.addEventListener("beforeunload", writeBounds);
    window.addEventListener("resize", writeBounds);
    window.addEventListener("focus", writeBounds);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", writeBounds);
      window.removeEventListener("resize", writeBounds);
      window.removeEventListener("focus", writeBounds);
    };
  }, [isDisplayWindow, viewMode]);

  useEffect(() => {
    if (viewMode === "workspace") {
      return undefined;
    }
    const timer = window.setInterval(() => {
      refresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [viewMode, activeSessionId, templateId]);

  useEffect(() => {
    if (!activeSession?.id) {
      setTranscript([]);
      setTranscriptSegments([]);
      setCorrectionSuggestions([]);
      setAudioAsset(null);
      setAgentQuestionEvents([]);
      setFdeOsValidation(null);
      return;
    }
    loadTranscript(activeSession.id).catch((transcriptError) => {
      setError(transcriptError instanceof Error ? transcriptError.message : String(transcriptError));
    });
    loadAnalysis(activeSession.id).catch((analysisError) => {
      setError(analysisError instanceof Error ? analysisError.message : String(analysisError));
    });
    loadAudioAsset(activeSession.id).catch((audioError) => {
      setError(audioError instanceof Error ? audioError.message : String(audioError));
    });
    loadAgentQuestionEvents(activeSession.id).catch((agentError) => {
      setError(agentError instanceof Error ? agentError.message : String(agentError));
    });
    loadFdeOsValidation(activeSession.id).catch((validationError) => {
      setFdeOsValidation(null);
      setFdeOsValidationMessage(validationError instanceof Error ? validationError.message : String(validationError));
    });
  }, [activeSession?.id]);

  useEffect(() => {
    if (!requirements.length) {
      setSelectedRequirementId("");
      return;
    }
    if (!requirements.some((item) => item.id === selectedRequirementId)) {
      setSelectedRequirementId(requirements[0].id);
    }
  }, [requirements, selectedRequirementId]);

  useEffect(() => {
    setEvidenceReviewNote(selectedEvidence?.review_note || "");
    setRelocationSegmentId(selectedEvidence?.transcript_segment_id || "");
  }, [selectedEvidence?.id, selectedEvidence?.review_note, selectedEvidence?.transcript_segment_id]);

  useEffect(() => {
    if (!activeReviewSegment) {
      setSegmentEditStartMs("");
      setSegmentEditEndMs("");
      setSegmentEditSplitMs("");
      setSegmentEditText("");
      return;
    }
    setSegmentEditStartMs(String(activeReviewSegment.start_ms));
    setSegmentEditEndMs(String(activeReviewSegment.end_ms));
    setSegmentEditSplitMs(String(Math.round((activeReviewSegment.start_ms + activeReviewSegment.end_ms) / 2)));
    setSegmentEditText(activeReviewSegment.corrected_text || activeReviewSegment.text);
  }, [
    activeReviewSegment?.id,
    activeReviewSegment?.start_ms,
    activeReviewSegment?.end_ms,
    activeReviewSegment?.text,
    activeReviewSegment?.corrected_text,
  ]);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (!recorder) {
        return;
      }
      recorder.processor.disconnect();
      recorder.source.disconnect();
      recorder.stream.getTracks().forEach((track) => track.stop());
      recorder.audioContext.close();
    };
  }, []);

  useEffect(() => {
    return () => {
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      if (segmentStopTimerRef.current) {
        window.clearTimeout(segmentStopTimerRef.current);
      }
    };
  }, []);

  function renderSpeakerControls(
    currentSpeaker: SpeakerRole,
    onSelect: (speaker: SpeakerRole) => void,
    ownerId: string,
  ) {
    return (
      <div className="speaker-controls" aria-label="说话人标注">
        {SPEAKER_OPTIONS.map((option) => (
          <button
            className={currentSpeaker === option.value ? "speaker-active" : ""}
            disabled={isDemoSession || speakerUpdateId === ownerId}
            key={option.value}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(option.value);
            }}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  const calibrationBanner =
    isDisplayWindow && displayLayout.calibration ? (
      <section className="calibration-banner">
        <div>
          <span>副屏校准中</span>
          <strong>
            {displaySlotLabel} · 当前显示 {effectiveDisplayLabel}
          </strong>
        </div>
        <p>把这个窗口拖到目标外接屏；若 FDE 和客户两面反了，在主控屏点击“交换 FDE/客户屏”，确认后保存布局。</p>
      </section>
    ) : null;

  if (isDisplayWindow && effectiveDisplayRole === "customer") {
    return (
      <main className="display-shell customer-display">
        <div className={`on-air-side-rails display-status-${displayStatus}`} aria-label={onAirSubtext}>
          <div className="on-air-rail on-air-rail-left">
            <span />
            <strong>{onAirText}</strong>
            <small>{onAirSubtext}</small>
          </div>
          <div className="on-air-rail on-air-rail-right">
            <span />
            <strong>{onAirText}</strong>
            <small>{onAirSubtext}</small>
          </div>
        </div>
        {calibrationBanner}
        <header className="display-topbar">
          <div>
            <span>客户共识屏</span>
            <h1>{projectTitle}</h1>
            <p>
              {customerTitle} · {selectedTemplateName}
            </p>
          </div>
          <div className="display-actions">
            <button className="display-button" type="button" onClick={() => navigateView("workspace")}>
              主控台
            </button>
            <button className="display-button" type="button" onClick={() => navigateView(otherDisplaySlot)}>
              {otherDisplaySlotLabel}
            </button>
            <button
              className="display-button display-button-primary"
              type="button"
              onClick={exportPrd}
              disabled={!activeSession || !exportReady || exportStatus !== "idle" || pipelineStatus !== "idle"}
            >
              <Download size={18} />
              导出 PRD
            </button>
          </div>
        </header>

        <section className="broadcast-hero">
          <div className="broadcast-copy">
            <div className={`recording-state-card recording-state-${displayStatus}`}>
              <Radio size={20} />
              <span>{onAirSubtext}</span>
            </div>
            <h2>客户可确认共识</h2>
            <p>
              {prd?.product_brief.positioning ||
                "访谈进行中，系统正在汇总客户可确认的项目定位、交付范围和成功指标。"}
            </p>
          </div>
          <div className="broadcast-strip">
            {stageStatusItems.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="customer-screen-grid">
          <article>
            <h2>核心模块</h2>
            <div className="display-tag-list">
              {visibleModules.map((module) => (
                <span key={module.name}>{module.name}</span>
              ))}
              {!visibleModules.length ? <span>等待分析</span> : null}
            </div>
          </article>
          <article>
            <h2>成功指标</h2>
            <ul>
              {visibleMetrics.map((metric) => (
                <li key={metric}>{metric}</li>
              ))}
              {!visibleMetrics.length ? <li>等待分析结果。</li> : null}
            </ul>
          </article>
          <article>
            <h2>交付状态</h2>
            <p>{transcriptReady ? "已完成本地转写" : "等待转写"}</p>
            <p>{analysisReady ? "PRD 摘要已生成" : "等待需求分析"}</p>
            <p>{exportReady ? "PRD 可导出" : "等待导出"}</p>
          </article>
        </section>
      </main>
    );
  }

  if (isDisplayWindow && effectiveDisplayRole === "fde") {
    return (
      <main className="display-shell fde-display">
        <div className={`on-air-side-rails display-status-${displayStatus}`} aria-label={onAirSubtext}>
          <div className="on-air-rail on-air-rail-left">
            <span />
            <strong>{onAirText}</strong>
            <small>{onAirSubtext}</small>
          </div>
          <div className="on-air-rail on-air-rail-right">
            <span />
            <strong>{onAirText}</strong>
            <small>{onAirSubtext}</small>
          </div>
        </div>
        {calibrationBanner}
        <header className="display-topbar fde-display-topbar">
          <div>
            <span>FDE 私有屏</span>
            <h1>{projectTitle}</h1>
            <p>
              {customerTitle} · {selectedTemplateName}
            </p>
          </div>
          <div className="display-actions">
            <button className="display-button" type="button" onClick={() => navigateView("workspace")}>
              主控台
            </button>
            <button className="display-button" type="button" onClick={() => navigateView(otherDisplaySlot)}>
              {otherDisplaySlotLabel}
            </button>
            <div className={`mini-on-air mini-on-air-${displayStatus}`}>
              <span />
              {onAirText}
            </div>
          </div>
        </header>

        <section className="fde-command-grid">
          <article className="private-questions">
            <div className="private-heading">
              <LockKeyhole size={22} />
              <div>
                <h2>下一轮补问</h2>
                <p>只给 FDE 自己看</p>
              </div>
              <div className="question-mode-switch">
                <span>发问方式</span>
                <div className="segmented-buttons compact-segmented">
                  <button
                    className={questionDeliveryMode === "tts" ? "segmented-active" : ""}
                    type="button"
                    onClick={() => setQuestionDeliveryMode("tts")}
                  >
                    TTS
                  </button>
                  <button
                    className={questionDeliveryMode === "fde" ? "segmented-active" : ""}
                    type="button"
                    onClick={() => setQuestionDeliveryMode("fde")}
                  >
                    FDE
                  </button>
                </div>
              </div>
              <div className="tts-toolbar">
                <button className="secondary-button" type="button" onClick={askNextQuestion} disabled={!displayQuestions.length}>
                  {questionDeliveryMode === "tts" ? <SkipForward size={16} /> : <Mic size={16} />}
                  {questionDeliveryMode === "tts" ? "朗读下一问" : "标记下一问"}
                </button>
                <button className="secondary-button" type="button" onClick={pauseTts} disabled={questionDeliveryMode !== "tts" || ttsStatus !== "speaking"}>
                  <Pause size={16} />
                  暂停
                </button>
                <button className="secondary-button" type="button" onClick={resumeTts} disabled={questionDeliveryMode !== "tts" || ttsStatus !== "paused"}>
                  <Play size={16} />
                  继续
                </button>
              </div>
            </div>
            <div className="private-question-list">
              {displayQuestions.map((item, index) => (
                <div key={item.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{item.question}</strong>
                  {item.reason ? <p>{item.reason}</p> : null}
                  {item.owner_role ? <small>{item.owner_role}</small> : null}
                  <button
                    className="secondary-button question-speak-button"
                    type="button"
                    onClick={() => askQuestion(item)}
                    disabled={questionDeliveryMode === "tts" && ttsStatus === "speaking" && currentTtsQuestionId === item.id}
                  >
                    {questionDeliveryMode === "tts" ? <Volume2 size={15} /> : <Mic size={15} />}
                    {questionDeliveryMode === "tts"
                      ? ttsStatus === "speaking" && currentTtsQuestionId === item.id
                        ? "朗读中"
                        : "朗读此问"
                      : "FDE 已问"}
                  </button>
                </div>
              ))}
              {!displayQuestions.length ? <p className="empty-state">暂无补问问题；可先完成需求分析。</p> : null}
            </div>
          </article>

          <aside className="private-side">
            <section>
              <h2>风险提醒</h2>
              <div className="private-risk-list">
                {displayRisks.map((item) => (
                  <article key={item.id}>
                    <strong>{item.title}</strong>
                    <p>{item.mitigation || item.description}</p>
                  </article>
                ))}
                {!displayRisks.length ? <p className="empty-state">暂无高优先级风险。</p> : null}
              </div>
            </section>
            <section>
              <h2>{correctionReady ? "转写校对稿" : "最近转写"}</h2>
              <div className="private-transcript-list">
                {privateTranscriptItems.map((item) => (
                  <article key={item.id}>
                    <span>{item.label}</span>
                    <p>{item.text}</p>
                  </article>
                ))}
                {!privateTranscriptItems.length ? <p className="empty-state">暂无转写。</p> : null}
              </div>
            </section>
            <section>
              <h2>发问记录</h2>
              <div className="private-transcript-list">
                {latestAgentQuestions.map((item) => (
                  <article key={item.id}>
                    <span>
                      {formatDateTime(item.created_at)} · {questionEventSourceLabel(item.source)}
                    </span>
                    <p>{item.question}</p>
                  </article>
                ))}
                {!latestAgentQuestions.length ? <p className="empty-state">暂无发问记录；完整复核以整段 raw.wav 为准。</p> : null}
              </div>
            </section>
          </aside>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">mac MVP P0</p>
          <h1>FDE 需求访谈助手</h1>
        </div>
        <button className="icon-button" type="button" onClick={refresh} aria-label="刷新">
          <RefreshCw size={18} />
        </button>
      </header>

      {error ? <section className="alert">{error}</section> : null}

      <section className="status-grid">
        <article className="metric">
          <Activity size={18} />
          <div>
            <span>Gateway</span>
            <strong>{health?.ok ? "Connected" : "Disconnected"}</strong>
          </div>
        </article>
        <article className="metric">
          <FileText size={18} />
          <div>
            <span>Templates</span>
            <strong>{templates.length}</strong>
          </div>
        </article>
        <article className="metric">
          <Captions size={18} />
          <div>
            <span>ASR</span>
            <strong>{health?.transcription?.model_ready ? "Local Ready" : "Local Missing"}</strong>
          </div>
        </article>
        <article className="metric">
          <Mic size={18} />
          <div>
            <span>Sessions</span>
            <strong>{sessions.length}</strong>
          </div>
        </article>
      </section>

      {isDemoSession ? (
        <section className="demo-banner">
          <strong>演示数据只读</strong>
          <span>当前 session 是本地只读演示样例。可以查看和导出，录音、ASR、校对保存和分析重跑请先新建访谈。</span>
          <button className="secondary-button" type="button" onClick={createWritableSessionFromCurrent} disabled={busy}>
            <Plus size={17} />
            创建可录音副本
          </button>
        </section>
      ) : null}

      <section className="session-dock panel">
        <div className="session-dock-main">
          <span>访谈工作区</span>
          <strong>{projectTitle}</strong>
          <small>
            {activeSession?.id || "未选择 session"} · {activeSession?.status || "idle"} · {selectedTemplateName}
          </small>
        </div>
        <label className="compact-select">
          当前访谈
          <select
            value={activeSession?.id || ""}
            onChange={(event) => setActiveSessionId(event.target.value)}
            disabled={recordingStatus !== "idle"}
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.project_name} - {session.id}
              </option>
            ))}
          </select>
        </label>
        <div className="session-dock-actions">
          <button className="secondary-button" type="button" onClick={() => openDisplayMode("customer")}>
            <MonitorUp size={17} />
            客户屏
          </button>
          <button className="secondary-button" type="button" onClick={() => openDisplayMode("fde")}>
            <Radio size={17} />
            FDE 屏
          </button>
          <button className="primary-button" type="button" onClick={exportPrd} disabled={!activeSession || !exportReady || exportStatus !== "idle"}>
            <Download size={18} />
            PRD
          </button>
          <button className="secondary-button" type="button" onClick={exportFdeOsBundle} disabled={!activeSession || exportStatus !== "idle"}>
            <Download size={17} />
            FDE OS 包
          </button>
          <button className="secondary-button" type="button" onClick={exportFdeOsStorePatch} disabled={!activeSession || exportStatus !== "idle"}>
            <Download size={17} />
            落库补丁
          </button>
        </div>
      </section>

      <section className="display-layout-panel panel">
        <div className="display-layout-copy">
          <span>副屏管理</span>
          <strong>双面外接屏手动校准</strong>
          <small>{displayLayoutMessage}</small>
        </div>
        <div className="display-layout-status">
          <div>
            <span>映射</span>
            <strong>{displayLayoutModeLabel}</strong>
          </div>
          <div>
            <span>校准</span>
            <strong>{displayLayoutCalibrationLabel}</strong>
          </div>
          <div>
            <span>保存</span>
            <strong>{displayLayoutSavedLabel}</strong>
          </div>
        </div>
        <div className="display-layout-actions">
          <button className="secondary-button" type="button" onClick={() => openDisplayMode("fde")}>
            <Radio size={17} />
            打开 FDE 屏
          </button>
          <button className="secondary-button" type="button" onClick={() => openDisplayMode("customer")}>
            <MonitorUp size={17} />
            打开客户屏
          </button>
          {displayLayout.calibration ? (
            <button className="secondary-button" type="button" onClick={exitDisplayCalibration}>
              <Check size={17} />
              退出校准
            </button>
          ) : (
            <button className="secondary-button" type="button" onClick={enterDisplayCalibration}>
              <MonitorUp size={17} />
              进入校准
            </button>
          )}
          <button className="secondary-button" type="button" onClick={swapDisplayRoles}>
            <ArrowLeftRight size={17} />
            交换 FDE/客户屏
          </button>
          <button className="primary-button" type="button" onClick={saveDisplayLayout}>
            <Save size={18} />
            保存布局
          </button>
        </div>
      </section>

      <section className="demo-stage">
        <div className="demo-stage-header">
          <div>
            <p className="eyebrow">演示讲解模式</p>
            <h2>{projectTitle}</h2>
            <p>
              {customerTitle} · {selectedTemplateName}
            </p>
          </div>
          <div className="demo-stage-actions">
            <button className="secondary-button" type="button" onClick={refresh}>
              <RefreshCw size={17} />
              刷新
            </button>
            <button className="secondary-button" type="button" onClick={() => openDisplayMode("customer")}>
              <MonitorUp size={17} />
              打开客户屏
              <ExternalLink size={14} />
            </button>
            <button className="secondary-button" type="button" onClick={() => openDisplayMode("fde")}>
              <Radio size={17} />
              打开 FDE 屏
              <ExternalLink size={14} />
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={exportPrd}
              disabled={!activeSession || !exportReady || exportStatus !== "idle" || pipelineStatus !== "idle"}
            >
              <Download size={18} />
              导出 PRD
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={exportFdeOsBundle}
              disabled={!activeSession || exportStatus !== "idle" || pipelineStatus !== "idle"}
            >
              <Download size={17} />
              FDE OS 包
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={exportFdeOsStorePatch}
              disabled={!activeSession || exportStatus !== "idle" || pipelineStatus !== "idle"}
            >
              <Download size={17} />
              落库补丁
            </button>
          </div>
        </div>

        <div className="stage-status-row">
          {stageStatusItems.map((item) => (
            <div className={`stage-status stage-status-${item.tone}`} key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>

        <div className="display-status-control">
          <div>
            <strong>副屏状态</strong>
            <span>{displayStatusMeta[displayStatus].label}</span>
          </div>
          <div className="segmented-buttons">
            {(["standby", "on_air", "processing"] as DisplayStatus[]).map((status) => (
              <button
                className={status === displayStatus ? "segmented-active" : ""}
                disabled={!activeSession || displayStatusBusy || (status === "on_air" && recordingStatus !== "recording" && !sessionIsOnAir)}
                key={status}
                onClick={() => updateDisplayStatus(status)}
                type="button"
              >
                {displayStatusMeta[status].text}
              </button>
            ))}
          </div>
        </div>

        <div className={`fde-os-bundle-panel fde-os-bundle-${fdeOsReadiness || "checking"}`}>
          <div className="fde-os-bundle-heading">
            <div>
              <span>FDE OS 对象包</span>
              <strong>{fdeOsStatusLabel}</strong>
              <p>{fdeOsValidation ? fdeOsValidationMessage : "正在读取对象包就绪度。"}</p>
            </div>
            <FileJson size={22} />
          </div>
          <div className="fde-os-bundle-stats">
            <div>
              <span>Artifacts</span>
              <strong>
                {fdeOsValidation
                  ? `${fdeOsValidation.summary.artifact_ready}/${fdeOsValidation.summary.artifact_total}`
                  : "--"}
              </strong>
            </div>
            <div>
              <span>Objects</span>
              <strong>{fdeOsValidation ? fdeOsValidation.summary.object_ref_total : "--"}</strong>
            </div>
            <div>
              <span>Req Evidence</span>
              <strong>
                {fdeOsValidation
                  ? `${fdeOsValidation.summary.requirement_with_evidence}/${fdeOsValidation.summary.requirement_total}`
                  : "--"}
              </strong>
            </div>
            <div>
              <span>Confirmed</span>
              <strong>{fdeOsValidation ? fdeOsValidation.summary.confirmed_evidence : "--"}</strong>
            </div>
            <div>
              <span>Issues</span>
              <strong>
                {fdeOsValidation ? `${fdeOsErrorCount}E/${fdeOsWarningCount}W` : "--"}
              </strong>
            </div>
          </div>
          <div className="fde-os-bundle-issues">
            {fdeOsTopIssues.map((issue) => (
              <span className={`fde-os-issue-${issue.severity}`} key={`${issue.code}-${issue.path}`}>
                {issue.severity === "error" ? "阻塞" : "提醒"} · {issue.message}
              </span>
            ))}
            {fdeOsValidation && !fdeOsTopIssues.length ? <span className="fde-os-issue-ok">对象包无阻塞或提醒项。</span> : null}
          </div>
          <div className="fde-os-bundle-actions">
            <button className="secondary-button" type="button" onClick={exportFdeOsBundle} disabled={!activeSession || exportStatus !== "idle"}>
              <Download size={16} />
              导出对象包
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={exportFdeOsStorePatch}
              disabled={!activeSession || !fdeOsValidation?.import_ready || exportStatus !== "idle"}
            >
              <Download size={17} />
              导出落库补丁
            </button>
          </div>
        </div>

        <div className="dual-screen-preview">
          <section className="audience-screen">
            <div className="screen-heading">
              <span>面向客户屏</span>
              <strong>交付共识</strong>
            </div>
            <p className="stage-brief">
              {prd?.product_brief.positioning ||
                "当前访谈会在这里汇总客户可确认的项目定位、交付范围和成功指标。"}
            </p>
            <div className="screen-section">
              <h3>核心模块</h3>
              <div className="compact-tag-list">
                {visibleModules.map((module) => (
                  <span key={module.name}>{module.name}</span>
                ))}
                {!visibleModules.length ? <span>等待分析</span> : null}
              </div>
            </div>
            <div className="screen-section">
              <h3>成功指标</h3>
              <ul>
                {visibleMetrics.map((metric) => (
                  <li key={metric}>{metric}</li>
                ))}
                {!visibleMetrics.length ? <li>等待分析结果。</li> : null}
              </ul>
            </div>
          </section>

          <section className="fde-screen">
            <div className="screen-heading">
              <span>FDE 私有屏</span>
              <strong>补问清单</strong>
            </div>
            <div className="question-stack">
              {visibleQuestions.map((item) => (
                <article key={item.id}>
                  <strong>{item.question}</strong>
                  {item.owner_role ? <span>{item.owner_role}</span> : null}
                </article>
              ))}
              {!visibleQuestions.length ? (
                <p className="empty-state">暂无补问问题；可先完成转写和需求分析。</p>
              ) : null}
            </div>
            <div className="screen-section">
              <h3>风险提醒</h3>
              <ul>
                {visibleRisks.map((item) => (
                  <li key={item.id}>{item.title}</li>
                ))}
                {!visibleRisks.length ? <li>暂无高优先级风险。</li> : null}
              </ul>
            </div>
          </section>
        </div>

        <div className="stage-footer">
          <span>{correctionReady ? "纠错稿已就绪" : "纠错稿未生成"}</span>
          <span>{exportStatus === "running" ? "导出中" : exportReady ? "PRD 可导出" : "等待 PRD 摘要"}</span>
        </div>
      </section>

      <section className="workspace">
        <form
          className="panel"
          onSubmit={(event) => {
            event.preventDefault();
            createSession();
          }}
        >
          <div className="panel-heading">
            <h2>新建访谈</h2>
            <p>创建本地 session，并预留 raw.wav、transcript、requirements 数据文件。</p>
          </div>

          <label>
            项目名称
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} />
          </label>

          <label>
            客户名称
            <input
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder="可选"
            />
          </label>

          <label>
            场景模板
            <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            访谈模式
            <select value={mode} onChange={(event) => setMode(event.target.value as "copilot" | "ai_host")}>
              <option value="copilot">旁听 Copilot</option>
              <option value="ai_host">AI 主持</option>
            </select>
          </label>

          <button className="primary-button" type="submit" disabled={busy || !templateId || !projectName.trim()}>
            <Plus size={18} />
            创建访谈
          </button>
        </form>

        <section className="panel">
          <div className="panel-heading">
            <h2>模板预览</h2>
            <p>{selectedTemplate?.description || "选择一个模板查看访谈阶段和必问问题。"}</p>
          </div>
          {selectedTemplate ? (
            <div className="template-preview">
              <div>
                <h3>访谈阶段</h3>
                <ul>
                  {selectedTemplate.interview_stages.map((stage) => (
                    <li key={stage}>{stage}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>必问问题</h3>
                <ul>
                  {selectedTemplate.required_questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </section>
      </section>

      <section className="panel recorder-panel">
        <div className="panel-heading">
          <h2>录音与 raw.wav 保存</h2>
          <p>选择一个访谈 session 后开始录音；结束时会编码为 16kHz mono WAV 并保存到本地 data 目录。</p>
        </div>
        <div className="recorder-controls">
          <label>
            当前访谈
            <select
              value={activeSession?.id || ""}
              onChange={(event) => setActiveSessionId(event.target.value)}
              disabled={recordingStatus !== "idle"}
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.project_name} - {session.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            发问方式
            <select
              value={questionDeliveryMode}
              onChange={(event) => setQuestionDeliveryMode(event.target.value as QuestionDeliveryMode)}
              disabled={recordingStatus !== "idle"}
            >
              <option value="tts">TTS 发问</option>
              <option value="fde">FDE 本人发问</option>
            </select>
          </label>
          <div className="recorder-actions">
            <button
              className="primary-button"
              type="button"
              onClick={startRecording}
              disabled={!activeSession || isDemoSession || recordingStatus !== "idle"}
            >
              <Mic size={18} />
              开始录音
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={stopRecordingAndUpload}
              disabled={isDemoSession || recordingStatus !== "recording"}
            >
              <CircleStop size={18} />
              结束并保存
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={discardCurrentRecording}
              disabled={isDemoSession || recordingStatus !== "recording"}
            >
              <Trash2 size={17} />
              放弃不保存
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={deleteCurrentSession}
              disabled={!activeSession || isDemoSession || recordingStatus !== "idle"}
            >
              <Trash2 size={17} />
              删除当前访谈
            </button>
          </div>
        </div>
        <p className="recording-message">{recordingMessage}</p>
        <div className="live-question-panel">
          <div className="live-question-main">
            <div className="live-question-kicker">
              <span>{questionQueueSourceLabel}</span>
              <strong>{nextQuestionAsked ? "本轮已记录" : "下一问"}</strong>
            </div>
            {nextQuestion ? (
              <>
                <p>{nextQuestion.question}</p>
                <small>
                  {nextQuestion.reason || "用于继续补齐访谈上下文。"}
                  {nextQuestion.owner_role ? ` · ${nextQuestion.owner_role}` : ""}
                </small>
              </>
            ) : (
              <p>暂无可发问问题。先选择模板或完成一次需求分析后，这里会出现下一问。</p>
            )}
          </div>
          <div className="live-question-controls">
            <label className="auto-ask-toggle">
              <input
                type="checkbox"
                checked={autoReadFirstQuestion}
                onChange={(event) => setAutoReadFirstQuestion(event.target.checked)}
                disabled={recordingStatus !== "idle" || questionDeliveryMode !== "tts"}
              />
              开始后自动朗读第一问
            </label>
            <div className="live-question-actions">
              <button className="primary-button" type="button" onClick={askNextQuestion} disabled={!nextQuestion}>
                {questionDeliveryMode === "tts" ? <Volume2 size={16} /> : <Mic size={16} />}
                {questionDeliveryMode === "tts" ? "朗读下一问" : "标记已问"}
              </button>
              <button className="secondary-button" type="button" onClick={pauseTts} disabled={questionDeliveryMode !== "tts" || ttsStatus !== "speaking"}>
                <Pause size={16} />
                暂停
              </button>
              <button className="secondary-button" type="button" onClick={resumeTts} disabled={questionDeliveryMode !== "tts" || ttsStatus !== "paused"}>
                <Play size={16} />
                继续
              </button>
              <button className="secondary-button" type="button" onClick={stopTts} disabled={questionDeliveryMode !== "tts" || ttsStatus === "idle"}>
                <CircleStop size={16} />
                停止
              </button>
              <button className="secondary-button" type="button" onClick={skipNextQuestion} disabled={!nextQuestion}>
                <SkipForward size={16} />
                跳过此问
              </button>
            </div>
          </div>
        </div>
        {activeSession ? (
          <p className="recording-path">
            保存路径：{activeSession.audio_path || `data/sessions/${activeSession.id}/audio/raw.wav`}
          </p>
        ) : null}
        <div className="audio-asset-panel">
          <div className="audio-asset-heading">
            <div>
              <h3>整段访谈录音证据</h3>
              <p>raw.wav 作为整场访谈的复核依据保留，用于事后回放、复原双方访谈内容并核对需求来源。</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => activeSession && loadAudioAsset(activeSession.id)}
              disabled={!activeSession}
            >
              <RefreshCw size={16} />
              刷新
            </button>
          </div>
          {activeSession && audioAsset?.exists ? (
            <>
              <audio
                controls
                key={`${activeSession.id}-${audioAsset.updated_at || ""}`}
                onPause={() => setAudioPlayback("paused")}
                onPlay={() => setAudioPlayback("playing")}
                onEnded={() => setAudioPlayback("idle")}
                preload="metadata"
                ref={audioRef}
                src={`${API_BASE}/sessions/${activeSession.id}/audio/raw-wav?ts=${encodeURIComponent(audioAsset.updated_at || "")}`}
              />
              <div className="audio-controls">
                <button className="secondary-button" type="button" onClick={playAudioAsset}>
                  <Play size={16} />
                  {audioPlayback === "paused" ? "继续" : "播放"}
                </button>
                <button className="secondary-button" type="button" onClick={pauseAudioAsset} disabled={audioPlayback !== "playing"}>
                  <Pause size={16} />
                  暂停
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => window.open(`${API_BASE}/sessions/${activeSession.id}/audio/raw-wav`, "_blank")}
                >
                  <Download size={16} />
                  打开文件
                </button>
              </div>
              <div className="audio-audit-grid">
                <div>
                  <span>证据范围</span>
                  <strong>整段访谈</strong>
                </div>
                <div>
                  <span>文件</span>
                  <strong>{audioAsset.filename}</strong>
                </div>
                <div>
                  <span>大小</span>
                  <strong>{formatBytes(audioAsset.size_bytes)}</strong>
                </div>
                <div>
                  <span>时长</span>
                  <strong>{audioAsset.duration_ms ? formatTimestamp(audioAsset.duration_ms) : "未知"}</strong>
                </div>
                <div>
                  <span>采样</span>
                  <strong>
                    {audioAsset.sample_rate || "-"} Hz / {audioAsset.channels || "-"} ch
                  </strong>
                </div>
                <div>
                  <span>更新时间</span>
                  <strong>{formatDateTime(audioAsset.updated_at)}</strong>
                </div>
                <div className="audio-hash">
                  <span>SHA256</span>
                  <strong>{audioAsset.sha256}</strong>
                </div>
              </div>
            </>
          ) : (
            <p className="empty-state">当前访谈还没有整段录音证据。创建可录音副本后开始录音，结束保存后会出现在这里。</p>
          )}
        </div>
      </section>

      <section className="panel transcript-panel">
        <div className="panel-heading">
          <h2>离线 ASR 转写</h2>
          <p>把当前访谈的 raw.wav 转成 transcript.json；转写固定走本地 sherpa-onnx，不调用外部 ASR 服务。</p>
        </div>
        <div className="transcript-toolbar">
          <button
            className="primary-button"
            type="button"
            onClick={runOfflineAsr}
            disabled={!activeSession || isDemoSession || !activeSession.audio_path || asrStatus !== "idle"}
          >
            <Wand2 size={18} />
            生成转写
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => activeSession && loadTranscript(activeSession.id)}
            disabled={!activeSession}
          >
            <Captions size={17} />
            刷新转写
          </button>
          <span>{asrStatus === "running" ? "ASR running" : asrMessage}</span>
        </div>
        <div className="transcript-list">
          {transcript.map((turn) => (
            <article className={`transcript-turn transcript-${turn.source}`} key={turn.id}>
              <div className="turn-header">
                <div className="turn-meta">
                  <strong>{speakerLabel(turn.speaker)}</strong>
                  <span>{turn.source}</span>
                  <span>
                    {formatTimestamp(turn.start_ms)}-{formatTimestamp(turn.end_ms)}
                  </span>
                </div>
                {renderSpeakerControls(turn.speaker, (speaker) => updateTurnSpeaker(turn, speaker), turn.id)}
              </div>
              <p>{turn.text}</p>
            </article>
          ))}
          {!transcript.length ? <p className="empty-state">当前访谈还没有 transcript 记录。</p> : null}
        </div>
        <div className="correction-panel">
          <div className="correction-heading">
            <div>
              <h3>转写校对</h3>
              <p>需求分析优先使用这里的纠错稿；适合修正生图、文宣、游客、景点名等 ASR 错词。</p>
            </div>
            <div className="recorder-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={normalizeTranscript}
                disabled={!activeSession || isDemoSession || !transcript.length || correctionStatus !== "idle"}
              >
                <Wand2 size={17} />
                生成纠错稿
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={saveCorrectedTranscript}
                disabled={!activeSession || isDemoSession || !correctedText.trim() || correctionStatus !== "idle"}
              >
                <Save size={17} />
                保存校对
              </button>
            </div>
          </div>
          <textarea
            value={correctedText}
            onChange={(event) => setCorrectedText(event.target.value)}
            placeholder="生成纠错稿后可在这里人工校对。"
            readOnly={isDemoSession}
            rows={8}
          />
          <div className="correction-meta">
            <span>{correctionStatus === "idle" ? correctionMessage : correctionStatus}</span>
            {correctedTranscript?.corrections.length ? (
              <div className="tag-list">
                {correctedTranscript.corrections.slice(0, 16).map((correction) => (
                  <span key={correction}>{correction}</span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="correction-suggestion-panel">
            <div className="correction-suggestion-heading">
              <div>
                <h3>术语复核 / 错词建议</h3>
                <p>
                  证据覆盖时同步顺读转写稿：高置信词可自动纠正，低置信词保留给 FDE 确认，避免污染 PRD 依据。
                </p>
              </div>
              <div className="recorder-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => scanCorrectionSuggestions(false)}
                  disabled={!activeSession || isDemoSession || !transcript.length || Boolean(suggestionBusy)}
                >
                  <RefreshCw size={16} />
                  扫描候选
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => scanCorrectionSuggestions(true)}
                  disabled={!activeSession || isDemoSession || !transcript.length || Boolean(suggestionBusy)}
                >
                  <Wand2 size={16} />
                  自动应用高置信
                </button>
              </div>
            </div>
            <div className="correction-suggestion-stats">
              <div>
                <span>待确认</span>
                <strong>{pendingCorrectionSuggestionCount}</strong>
              </div>
              <div>
                <span>高置信待应用</span>
                <strong>{safePendingCorrectionCount}</strong>
              </div>
              <div>
                <span>需人工判断</span>
                <strong>{uncertainCorrectionSuggestionCount}</strong>
              </div>
              <div>
                <span>已应用</span>
                <strong>{appliedCorrectionSuggestionCount}</strong>
              </div>
            </div>
            <div className="correction-suggestion-list">
              {correctionSuggestions.slice(0, 12).map((item) => (
                <article className={`correction-suggestion correction-suggestion-${item.status}`} key={item.id}>
                  <div className="correction-suggestion-main">
                    <div>
                      <strong>
                        {item.wrong_text} <span>{"->"}</span> {item.suggested_text}
                      </strong>
                      <p>{item.reason}</p>
                    </div>
                    <span className={`review-status-pill correction-status-${item.status}`}>
                      {correctionSuggestionStatusLabel(item.status)}
                    </span>
                  </div>
                  <div className="correction-suggestion-meta">
                    <span>{correctionSuggestionSourceLabel(item.source)}</span>
                    <span>出现 {item.occurrence_count} 次</span>
                    <span>置信度 {item.confidence.toFixed(2)}</span>
                    <span>{item.safe_auto_apply ? "可自动" : "需确认"}</span>
                  </div>
                  {item.occurrences.length ? (
                    <div className="correction-occurrence-list">
                      {item.occurrences.slice(0, 2).map((occurrence) => (
                        <button
                          key={`${item.id}-${occurrence.transcript_segment_id || occurrence.transcript_turn_id}-${occurrence.start_ms}`}
                          onClick={() => {
                            if (occurrence.transcript_segment_id) {
                              setRelocationSegmentId(occurrence.transcript_segment_id);
                            }
                            playAudioRange(occurrence.start_ms, occurrence.end_ms);
                          }}
                          type="button"
                          disabled={!audioAsset?.exists}
                        >
                          <Play size={13} />
                          <span>
                            {occurrence.transcript_segment_id || occurrence.transcript_turn_id || "turn"} ·{" "}
                            {formatTimestamp(occurrence.start_ms)}-{formatTimestamp(occurrence.end_ms)}
                          </span>
                          <small>{occurrence.excerpt}</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="correction-suggestion-actions">
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => updateCorrectionSuggestion(item, "apply")}
                      disabled={isDemoSession || item.status !== "pending" || Boolean(suggestionBusy)}
                    >
                      <Check size={14} />
                      应用
                    </button>
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => updateCorrectionSuggestion(item, "ignore")}
                      disabled={isDemoSession || item.status !== "pending" || Boolean(suggestionBusy)}
                    >
                      忽略
                    </button>
                  </div>
                </article>
              ))}
              {!correctionSuggestions.length ? (
                <p className="empty-state">暂无错词建议。生成转写后可扫描候选，或在证据复核时自动刷新建议。</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="panel analysis-panel">
        <div className="panel-heading">
          <h2>需求分析抽取</h2>
          <p>从 transcript.json 生成 requirements、risks 和 open_questions，作为 FDE 访谈后的第一版需求草稿。</p>
        </div>
        <div className="transcript-toolbar">
          <button
            className="primary-button"
            type="button"
            onClick={processSession}
            disabled={!activeSession || isDemoSession || !activeSession.audio_path || pipelineStatus !== "idle"}
          >
            <Wand2 size={18} />
            一键处理
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={extractAnalysis}
            disabled={!activeSession || isDemoSession || !transcript.length || analysisStatus !== "idle" || pipelineStatus !== "idle"}
          >
            <ListChecks size={18} />
            抽取需求分析
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => activeSession && loadAnalysis(activeSession.id)}
            disabled={!activeSession || pipelineStatus !== "idle"}
          >
            <RefreshCw size={17} />
            刷新分析
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={exportRequirementsAnalysis}
            disabled={!activeSession || exportStatus !== "idle" || pipelineStatus !== "idle"}
          >
            <Download size={17} />
            导出需求分析
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={exportPrd}
            disabled={!activeSession || exportStatus !== "idle" || pipelineStatus !== "idle"}
          >
            <Download size={17} />
            导出 PRD
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={exportFdeOsBundle}
            disabled={!activeSession || exportStatus !== "idle" || pipelineStatus !== "idle"}
          >
            <Download size={17} />
            FDE OS 包
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={exportFdeOsStorePatch}
            disabled={!activeSession || exportStatus !== "idle" || pipelineStatus !== "idle"}
          >
            <Download size={17} />
            落库补丁
          </button>
          <span>{pipelineStatus === "running" ? "Pipeline running" : analysisStatus === "running" ? "Analysis running" : analysisMessage}</span>
        </div>
        <div className={`analysis-quality-card analysis-quality-${analysisQuality.tone}`}>
          <div>
            <span className="analysis-quality-label">分析质量</span>
            <strong>{analysisQuality.label}</strong>
            <p>{analysisQuality.detail}</p>
          </div>
          <div className="analysis-quality-meta">
            <span>模型：{analysisQuality.engine}</span>
            <span>
              证据覆盖：{requirements.length ? `${evidenceBackedCount}/${requirements.length}` : "等待需求项"}
            </span>
            <span>低置信：{lowConfidenceEvidenceCount}</span>
            <span>待纠错：{pendingCorrectionSuggestionCount}</span>
            <span>需求项：{requirements.length || 0}</span>
          </div>
        </div>
        <p className="recording-path">{exportStatus === "running" ? "Export running" : exportMessage}</p>
        {prd ? (
          <div className="prd-summary">
            <section>
              <h3>PRD 摘要</h3>
              <p>{prd.product_brief.positioning || "暂无产品定位。"}</p>
              <p className="muted-text">{prd.product_brief.problem_statement}</p>
            </section>
            <section>
              <h3>功能模块</h3>
              <div className="tag-list">
                {prd.feature_modules.map((module) => (
                  <span key={module.name}>{module.name}</span>
                ))}
                {!prd.feature_modules.length ? <span>未生成</span> : null}
              </div>
            </section>
            <section>
              <h3>成功指标</h3>
              <ul>
                {prd.success_metrics.map((metric) => (
                  <li key={metric}>{metric}</li>
                ))}
                {!prd.success_metrics.length ? <li>暂无成功指标。</li> : null}
              </ul>
            </section>
            {prd.transcript_corrections.length ? (
              <section>
                <h3>转写纠错</h3>
                <div className="tag-list">
                  {prd.transcript_corrections.slice(0, 12).map((correction) => (
                    <span key={correction}>{correction}</span>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
        <div className="analysis-grid">
          <section>
            <h3>需求项</h3>
            <div className="analysis-list">
              {requirements.map((item) => {
                const evidence = item.evidence_refs?.[0];
                const evidenceMeta = evidenceCoverageMeta(evidence);
                return (
                  <article className="analysis-item" key={item.id}>
                    <div className="turn-meta">
                      <strong>{item.title}</strong>
                      <span>{item.priority}</span>
                      <span>{item.type}</span>
                      <span className={`review-status-pill evidence-status-${evidenceMeta.tone}`}>{evidenceMeta.label}</span>
                      {evidence ? (
                        <span>
                          {formatTimestamp(evidence.start_ms)}-{formatTimestamp(evidence.end_ms)}
                        </span>
                      ) : null}
                    </div>
                    {item.module ? <p className="muted-text">模块：{item.module}</p> : null}
                    <p>{item.description}</p>
                    {evidence ? (
                      <button
                        className="inline-evidence-play"
                        disabled={!audioAsset?.exists}
                        onClick={() => playEvidenceSegment(evidence)}
                        type="button"
                      >
                        <Play size={14} />
                        播放证据 · 置信度 {evidence.confidence.toFixed(2)}
                      </button>
                    ) : (
                      <p className="evidence-missing-note">{evidenceMeta.detail}</p>
                    )}
                    {item.user_story ? <p className="muted-text">{item.user_story}</p> : null}
                    {item.acceptance_criteria.length ? (
                      <ul>
                        {item.acceptance_criteria.map((criterion) => (
                          <li key={criterion}>{criterion}</li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                );
              })}
              {!requirements.length ? <p className="empty-state">还没有需求项。</p> : null}
            </div>
          </section>
          <section>
            <h3>风险</h3>
            <div className="analysis-list">
              {risks.map((item) => (
                <article className="analysis-item risk-item" key={item.id}>
                  <div className="turn-meta">
                    <ShieldAlert size={15} />
                    <strong>{item.title}</strong>
                    <span>{item.severity}</span>
                  </div>
                  <p>{item.description}</p>
                  {item.mitigation ? <p className="muted-text">缓解：{item.mitigation}</p> : null}
                </article>
              ))}
              {!risks.length ? <p className="empty-state">还没有风险项。</p> : null}
            </div>
          </section>
          <section>
            <h3>未决问题</h3>
            <div className="analysis-list">
              {openQuestions.map((item) => (
                <article className="analysis-item question-item" key={item.id}>
                  <strong>{item.question}</strong>
                  {item.reason ? <p>{item.reason}</p> : null}
                  {item.owner_role ? <p className="muted-text">建议询问：{item.owner_role}</p> : null}
                </article>
              ))}
              {!openQuestions.length ? <p className="empty-state">还没有未决问题。</p> : null}
            </div>
          </section>
        </div>
      </section>

      <section className="panel review-panel">
        <div className="panel-heading">
          <h2>访谈复核</h2>
          <p>用整段录音、转写校对稿和需求条目依据复核 PRD 内容，确认需求确实来自访谈。</p>
        </div>
        <div className="evidence-coverage-row">
          <div>
            <span>证据覆盖</span>
            <strong>
              {evidenceBackedCount}/{requirements.length || 0}
            </strong>
          </div>
          <div>
            <span>已确认</span>
            <strong>{confirmedEvidenceCount}</strong>
          </div>
          <div>
            <span>低置信待复核</span>
            <strong>{lowConfidenceEvidenceCount}</strong>
          </div>
          <div>
            <span>未定位</span>
            <strong>{missingEvidenceCount}</strong>
          </div>
          <div>
            <span>待确认错词</span>
            <strong>{pendingCorrectionSuggestionCount}</strong>
          </div>
        </div>
        <div className="review-grid">
          <section className="review-audio-card">
            <div className="review-card-heading">
              <h3>整段录音</h3>
              <span>{audioAsset?.exists ? `${formatTimestamp(audioAsset.duration_ms || 0)} · ${formatBytes(audioAsset.size_bytes)}` : "暂无录音"}</span>
            </div>
            {activeSession && audioAsset?.exists ? (
              <>
                <audio
                  controls
                  preload="metadata"
                  ref={reviewAudioRef}
                  src={`${API_BASE}/sessions/${activeSession.id}/audio/raw-wav?ts=${encodeURIComponent(audioAsset.updated_at || "")}`}
                />
                <div className="review-evidence-meta">
                  <span>SHA256</span>
                  <strong>{audioAsset.sha256}</strong>
                </div>
              </>
            ) : (
              <p className="empty-state">暂无整段录音证据。</p>
            )}
          </section>

          <section className="review-transcript-card">
            <div className="review-card-heading">
              <h3>{reviewTranscriptLabel}</h3>
              <span>{transcriptSegments.length ? `${transcriptSegments.length} segments` : transcript.length ? `${transcript.length} turns` : "not ready"}</span>
            </div>
            {transcriptSegments.length ? (
              <div className="review-segment-list">
                {transcriptSegments.map((segment) => (
                  <article
                    className={activeReviewSegment?.id === segment.id ? "review-segment-active" : ""}
                    key={segment.id}
                  >
                    <button className="review-segment-select" type="button" onClick={() => setRelocationSegmentId(segment.id)}>
                      <span>
                        {segment.id} · {formatTimestamp(segment.start_ms)}-{formatTimestamp(segment.end_ms)} ·{" "}
                        {speakerLabel(segment.speaker)} · {segment.source}
                      </span>
                      <p>{segment.corrected_text || segment.text}</p>
                    </button>
                    {renderSpeakerControls(segment.speaker, (speaker) => updateSegmentSpeaker(segment, speaker), segment.id)}
                    {activeReviewSegment?.id === segment.id ? (
                      <div className="segment-boundary-editor">
                        <div className="segment-timebar" aria-label="片段时间轴">
                          <span className="segment-timebar-range" style={segmentTimelineMetrics(segment).rangeStyle} />
                          <i className="segment-timebar-split" style={segmentTimelineMetrics(segment).splitStyle} />
                        </div>
                        <div className="segment-editor-summary">
                          <span>片段时长 {formatTimestamp(segmentTimelineMetrics(segment).draftDurationMs)}</span>
                          <button
                            className="secondary-button compact-button"
                            disabled={!audioAsset?.exists || segmentEditBusy}
                            onClick={playSegmentDraft}
                            type="button"
                          >
                            <Play size={14} />
                            播放当前边界
                          </button>
                        </div>
                        <div className="segment-editor-fields">
                          <label>
                            <span>开始 ms</span>
                            <input
                              disabled={isDemoSession || segmentEditBusy}
                              inputMode="numeric"
                              onChange={(event) => setSegmentEditStartMs(event.target.value)}
                              value={segmentEditStartMs}
                            />
                          </label>
                          <label>
                            <span>结束 ms</span>
                            <input
                              disabled={isDemoSession || segmentEditBusy}
                              inputMode="numeric"
                              onChange={(event) => setSegmentEditEndMs(event.target.value)}
                              value={segmentEditEndMs}
                            />
                          </label>
                          <label>
                            <span>拆分 ms</span>
                            <input
                              disabled={isDemoSession || segmentEditBusy}
                              inputMode="numeric"
                              onChange={(event) => setSegmentEditSplitMs(event.target.value)}
                              value={segmentEditSplitMs}
                            />
                          </label>
                        </div>
                        <div className="segment-nudge-grid">
                          <div>
                            <span>起点</span>
                            <button disabled={isDemoSession || segmentEditBusy} onClick={() => nudgeSegmentTime("start", -500)} type="button">
                              -500
                            </button>
                            <button disabled={isDemoSession || segmentEditBusy} onClick={() => nudgeSegmentTime("start", 500)} type="button">
                              +500
                            </button>
                          </div>
                          <div>
                            <span>终点</span>
                            <button disabled={isDemoSession || segmentEditBusy} onClick={() => nudgeSegmentTime("end", -500)} type="button">
                              -500
                            </button>
                            <button disabled={isDemoSession || segmentEditBusy} onClick={() => nudgeSegmentTime("end", 500)} type="button">
                              +500
                            </button>
                          </div>
                          <div>
                            <span>拆分点</span>
                            <button disabled={isDemoSession || segmentEditBusy} onClick={() => nudgeSegmentTime("split", -500)} type="button">
                              -500
                            </button>
                            <button disabled={isDemoSession || segmentEditBusy} onClick={() => nudgeSegmentTime("split", 500)} type="button">
                              +500
                            </button>
                          </div>
                        </div>
                        <textarea
                          disabled={isDemoSession || segmentEditBusy}
                          onChange={(event) => setSegmentEditText(event.target.value)}
                          rows={4}
                          value={segmentEditText}
                        />
                        <div className="segment-editor-actions">
                          <button
                            className="primary-button"
                            disabled={isDemoSession || segmentEditBusy}
                            onClick={() => saveSegmentBoundary(segment)}
                            type="button"
                          >
                            <Save size={15} />
                            保存边界
                          </button>
                          <button
                            className="secondary-button"
                            disabled={isDemoSession || segmentEditBusy}
                            onClick={() => splitSegment(segment)}
                            type="button"
                          >
                            <ArrowLeftRight size={15} />
                            拆分
                          </button>
                          <button
                            className="secondary-button"
                            disabled={isDemoSession || segmentEditBusy}
                            onClick={() => mergeSegmentWithNext(segment)}
                            type="button"
                          >
                            <SkipForward size={15} />
                            合并下一段
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <div className="review-transcript-text">
                {reviewTranscriptText ? reviewTranscriptText : "暂无转写内容。"}
              </div>
            )}
          </section>

          <section className="review-requirements-card">
            <div className="review-card-heading">
              <h3>需求依据</h3>
              <span>{requirements.length ? `${requirements.length} reqs` : "not ready"}</span>
            </div>
            <div className="review-requirement-list">
              {requirements.map((item) => {
                const evidence = item.evidence_refs?.[0];
                const evidenceMeta = evidenceCoverageMeta(evidence);
                return (
                  <button
                    className={selectedRequirement?.id === item.id ? "review-requirement-active" : ""}
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedRequirementId(item.id)}
                  >
                    <strong>{item.title}</strong>
                    <span>
                      {item.module || "未归类"} · {item.priority}
                    </span>
                    <em className={`review-status-pill evidence-status-${evidenceMeta.tone}`}>
                      {evidenceMeta.label}
                    </em>
                    {evidence ? (
                      <small>
                        证据 {formatTimestamp(evidence.start_ms)}-
                        {formatTimestamp(evidence.end_ms)}
                        {" "}· {evidence.confidence.toFixed(2)}
                      </small>
                    ) : null}
                  </button>
                );
              })}
              {!requirements.length ? <p className="empty-state">暂无需求项。</p> : null}
            </div>
          </section>

          <section className="review-selected-card">
            <div className="review-card-heading">
              <h3>当前复核项</h3>
              <span>{selectedRequirement?.id || "not selected"}</span>
            </div>
            {selectedRequirement ? (
              <div className="review-selected-content">
                <h4>{selectedRequirement.title}</h4>
                <p>{selectedRequirement.description}</p>
                {selectedRequirement.evidence ? (
                  <blockquote>{selectedRequirement.evidence}</blockquote>
                ) : (
                  <p className="empty-state">该需求暂未写入访谈依据。</p>
                )}
                {selectedEvidence ? (
                  <div className="evidence-location-card">
                    <div className="evidence-review-bar">
                      <span className={`review-status-pill review-status-${selectedEvidenceStatus}`}>
                        {selectedEvidenceReviewMeta.label}
                      </span>
                      <small>
                        {selectedEvidence.reviewed_at ? `复核于 ${formatDateTime(selectedEvidence.reviewed_at)}` : "尚未人工复核"}
                      </small>
                    </div>
                    <div>
                      <strong>证据片段</strong>
                      <span>
                        raw.wav {formatTimestamp(selectedEvidence.start_ms)}-
                        {formatTimestamp(selectedEvidence.end_ms)}
                        {selectedEvidence.transcript_segment_id ? ` · ${selectedEvidence.transcript_segment_id}` : ""} · 置信度{" "}
                        {selectedEvidence.confidence.toFixed(2)}
                      </span>
                    </div>
                    <p>{selectedEvidence.corrected_excerpt || selectedEvidence.transcript_excerpt}</p>
                    <div className="evidence-relocation-card">
                      <div>
                        <strong>人工重定位</strong>
                        <span>
                          {relocationSegment
                            ? `已选择 ${relocationSegment.id} · ${formatTimestamp(relocationSegment.start_ms)}-${formatTimestamp(relocationSegment.end_ms)}`
                            : "请在左侧转写片段中选择"}
                        </span>
                      </div>
                      {relocationSegment ? <p>{relocationSegment.corrected_text || relocationSegment.text}</p> : null}
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={relocateEvidenceToSegment}
                        disabled={!relocationChanged || evidenceRelocationBusy}
                      >
                        <Check size={16} />
                        设为当前需求证据
                      </button>
                    </div>
                    <div className="evidence-review-controls">
                      <textarea
                        aria-label="证据复核备注"
                        placeholder="复核备注，例如：客户原话已覆盖该需求，或时间点需要重新定位。"
                        value={evidenceReviewNote}
                        onChange={(event) => setEvidenceReviewNote(event.target.value)}
                      />
                      <div>
                        <button
                          className="primary-button"
                          type="button"
                          onClick={() => playEvidenceSegment(selectedEvidence)}
                          disabled={!audioAsset?.exists}
                        >
                          <Play size={16} />
                          播放此处
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => updateEvidenceReviewStatus("confirmed")}
                          disabled={evidenceReviewBusy}
                        >
                          <Check size={16} />
                          确认此证据
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => updateEvidenceReviewStatus("needs_relocation")}
                          disabled={evidenceReviewBusy}
                        >
                          <ShieldAlert size={16} />
                          需重定位
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => updateEvidenceReviewStatus("unreviewed")}
                          disabled={evidenceReviewBusy}
                        >
                          未复核
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="empty-state">该需求尚未定位到 raw.wav 时间点。</p>
                )}
                {selectedRequirement.acceptance_criteria.length ? (
                  <div>
                    <strong>验收标准</strong>
                    <ul>
                      {selectedRequirement.acceptance_criteria.map((criterion) => (
                        <li key={criterion}>{criterion}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="empty-state">选择一个需求项后查看访谈依据。</p>
            )}
          </section>
        </div>
      </section>

    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
