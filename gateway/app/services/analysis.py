from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any

import httpx

from app.core.settings import Settings
from app.models.analysis import (
    AnalysisResult,
    FeatureModule,
    OpenQuestionItem,
    PrdOutline,
    ProductBrief,
    RequirementItem,
    RiskItem,
    UserJourneyStep,
)
from app.models.session import InterviewSession
from app.models.template import ScenarioTemplate
from app.models.transcript import TranscriptTurn
from app.services.storage import utc_now


DEFAULT_CORRECTIONS: dict[str, str] = {}


def analyze_transcript(
    settings: Settings,
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript: list[TranscriptTurn],
) -> AnalysisResult:
    raw_text = "\n".join(f"[{turn.speaker}] {turn.text}" for turn in transcript if turn.text.strip())
    if not raw_text:
        return _empty_fallback_result(session.id, template, "Transcript is empty.")

    normalized_text, corrections = normalize_transcript_text(raw_text, template.glossary)
    api_key = os.getenv("FDE_LLM_API_KEY", "").strip()
    base_url = os.getenv("FDE_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("FDE_LLM_MODEL", "gpt-4.1-mini")
    if api_key:
        try:
            return _call_openai_compatible(
                session=session,
                template=template,
                transcript_text=normalized_text,
                corrections=corrections,
                base_url=base_url,
                api_key=api_key,
                model=model,
            )
        except Exception as error:
            return _local_prd_result(
                session=session,
                template=template,
                transcript_text=normalized_text,
                corrections=corrections,
                message=f"LLM call failed, used local PRD extractor: {error}",
            )

    return _local_prd_result(
        session=session,
        template=template,
        transcript_text=normalized_text,
        corrections=corrections,
        message="FDE_LLM_API_KEY is not set, used local PRD extractor.",
    )


def analyze_transcript_local(
    settings: Settings,
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript: list[TranscriptTurn],
    message: str = "Local PRD extractor completed.",
) -> AnalysisResult:
    raw_text = "\n".join(f"[{turn.speaker}] {turn.text}" for turn in transcript if turn.text.strip())
    if not raw_text:
        return _empty_fallback_result(session.id, template, "Transcript is empty.")
    normalized_text, corrections = normalize_transcript_text(raw_text, template.glossary)
    return _local_prd_result(session=session, template=template, transcript_text=normalized_text, corrections=corrections, message=message)


def analyze_transcript_llm(
    settings: Settings,
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript: list[TranscriptTurn],
) -> AnalysisResult:
    raw_text = "\n".join(f"[{turn.speaker}] {turn.text}" for turn in transcript if turn.text.strip())
    if not raw_text:
        return _empty_fallback_result(session.id, template, "Transcript is empty.")
    api_key = os.getenv("FDE_LLM_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("FDE_LLM_API_KEY is not set.")
    normalized_text, corrections = normalize_transcript_text(raw_text, template.glossary)
    base_url = os.getenv("FDE_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("FDE_LLM_MODEL", "gpt-4.1-mini")
    return _call_openai_compatible(
        session=session,
        template=template,
        transcript_text=normalized_text,
        corrections=corrections,
        base_url=base_url,
        api_key=api_key,
        model=model,
    )


def normalize_transcript_text(text: str, glossary: dict[str, str] | None = None) -> tuple[str, list[str]]:
    normalized = text
    applied: list[str] = []
    corrections = {**DEFAULT_CORRECTIONS, **(glossary or {})}
    for wrong, right in corrections.items():
        if not is_transcript_replacement_rule(wrong, right):
            continue
        if wrong in normalized:
            normalized = normalized.replace(wrong, right)
            applied.append(f"{wrong} -> {right}")
    normalized = re.sub(r"(呃|嗯|啊|哎|呢|嘛){2,}", r"\1", normalized)
    normalized = re.sub(r"\s+", "\n", normalized).strip()
    return normalized, applied


def is_transcript_replacement_rule(wrong: str, right: str) -> bool:
    wrong_text = str(wrong or "").strip()
    right_text = str(right or "").strip()
    if not wrong_text or not right_text or wrong_text == right_text:
        return False
    if len(right_text) > 24:
        return False
    if any(mark in right_text for mark in ["，", "。", "；", "\n"]):
        return False
    if "/" in right_text and len(right_text) > 12:
        return False
    return True


def _call_openai_compatible(
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript_text: str,
    corrections: list[str],
    base_url: str,
    api_key: str,
    model: str,
) -> AnalysisResult:
    chunk_chars = int(os.getenv("FDE_LLM_CHUNK_CHARS", "2600"))
    chunk_overlap = int(os.getenv("FDE_LLM_CHUNK_OVERLAP", "250"))
    chunks = _chunk_text(transcript_text, max_chars=chunk_chars, overlap=chunk_overlap)
    chunk_facts: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks, start=1):
        chunk_facts.append(
            _request_json(
                base_url=base_url,
                api_key=api_key,
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": "你是 FDE 需求访谈分析助手。只输出严格 JSON。",
                    },
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "task": "从一个访谈分块中抽取 PRD 事实，不要生成空泛需求。",
                                "project": session.project_name,
                                "customer": session.customer_name,
                                "template": template.model_dump(mode="json"),
                                "chunk_index": index,
                                "chunk_count": len(chunks),
                                "transcript_chunk": chunk,
                                "output_schema": {
                                    "facts": ["明确事实，使用纠错后的业务语言"],
                                    "requirements": ["可开发功能或约束"],
                                    "metrics": ["指标、成本、性能、验收口径"],
                                    "risks": ["风险"],
                                    "open_questions": ["不确定但需要追问的问题"],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    },
                ],
            )
        )

    synthesis_payload = {
        "task": "把访谈事实综合成可直接用于 PRD 和软件开发的结构化需求分析。",
        "rules": [
            "不要输出“确认功能需求”这类占位描述。",
            "每条功能需求必须有模块、用户故事、业务规则、数据对象、依赖、验收标准和转写证据。",
            "把不确定信息放入 open_questions，不要伪装成确定需求。",
            "输出必须能指导工程拆分、接口设计、数据表设计和验收测试。",
        ],
        "project": session.project_name,
        "customer": session.customer_name,
        "template": template.model_dump(mode="json"),
        "asr_corrections": corrections,
        "chunk_facts": chunk_facts,
        "output_schema": _schema_hint(),
    }
    if _truthy_env("FDE_LLM_LOCAL_SYNTHESIS"):
        return _synthesize_from_chunk_facts(
            session=session,
            template=template,
            transcript_text=transcript_text,
            corrections=corrections,
            chunk_facts=chunk_facts,
            engine=f"openai-compatible:{model}+local-synthesis",
            message="Kimi chunk extraction completed; local schema synthesis assembled the PRD.",
        )
    try:
        payload = _request_json(
            base_url=base_url,
            api_key=api_key,
            model=model,
            messages=[
                {"role": "system", "content": "你只输出严格 JSON，不要 Markdown。"},
                {"role": "user", "content": json.dumps(synthesis_payload, ensure_ascii=False)},
            ],
        )
    except Exception as error:
        if _truthy_env("FDE_LLM_ALLOW_LOCAL_SYNTHESIS", default=True):
            return _synthesize_from_chunk_facts(
                session=session,
                template=template,
                transcript_text=transcript_text,
                corrections=corrections,
                chunk_facts=chunk_facts,
                engine=f"openai-compatible:{model}+local-synthesis",
                message=f"Kimi chunk extraction completed; local schema synthesis used after final JSON failed: {error}",
            )
        raise
    result = _parse_payload(session.id, payload, f"openai-compatible:{model}", "completed", "PRD-grade analysis completed.")
    if corrections and not result.prd.transcript_corrections:
        result.prd.transcript_corrections = corrections
    if not result.requirements and not result.risks and not result.open_questions:
        return _local_prd_result(session, template, transcript_text, corrections, "LLM returned an empty analysis, used local PRD extractor.")
    return result


def _request_json(base_url: str, api_key: str, model: str, messages: list[dict[str, str]]) -> dict[str, Any]:
    timeout_seconds = float(os.getenv("FDE_LLM_TIMEOUT_SECONDS", "180"))
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    max_tokens = os.getenv("FDE_LLM_MAX_TOKENS", "").strip()
    if max_tokens:
        payload["max_tokens"] = int(max_tokens)
    thinking_mode = os.getenv("FDE_LLM_THINKING", "").strip()
    if thinking_mode:
        payload["thinking"] = {"type": thinking_mode}
    last_error: Exception | None = None
    timeout = httpx.Timeout(timeout_seconds, connect=20)
    with httpx.Client(timeout=timeout) as client:
        for attempt in range(3):
            try:
                response = client.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=payload,
                )
                response.raise_for_status()
                choice = response.json()["choices"][0]
                message = choice["message"]
                content = message.get("content") or ""
                if not content.strip():
                    finish_reason = choice.get("finish_reason") or "unknown"
                    reasoning_length = len(message.get("reasoning_content") or "")
                    raise RuntimeError(
                        f"LLM returned empty JSON content. finish_reason={finish_reason}, reasoning_length={reasoning_length}"
                    )
                return _parse_json_content(content)
            except Exception as error:
                last_error = error
                if attempt == 2:
                    raise
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"LLM call failed: {last_error}")


def _parse_json_content(content: str) -> dict[str, Any]:
    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


def _truthy_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _synthesize_from_chunk_facts(
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript_text: str,
    corrections: list[str],
    chunk_facts: list[dict[str, Any]],
    engine: str,
    message: str,
) -> AnalysisResult:
    result = _local_prd_result(session, template, transcript_text, corrections, message)
    result.engine = engine
    result.status = "completed"
    result.message = message

    facts = _fact_strings(chunk_facts, "facts")
    metrics = _fact_strings(chunk_facts, "metrics")
    risks = _fact_strings(chunk_facts, "risks")
    questions = _fact_strings(chunk_facts, "open_questions")
    requirements = _fact_strings(chunk_facts, "requirements")

    if facts:
        result.prd.product_brief.problem_statement = _join_compact(facts[:6])
    if metrics:
        result.prd.success_metrics = _dedupe(result.prd.success_metrics + metrics[:8])

    now = utc_now()
    existing_risk_titles = {item.title for item in result.risks}
    for risk in risks[:6]:
        title = risk[:36]
        if title not in existing_risk_titles:
            result.risks.append(
                _risk(
                    title=title,
                    description=risk,
                    severity="medium",
                    mitigation="进入后续访谈复核，并转成验收或风控规则。",
                    evidence=risk,
                    now=now,
                )
            )
            existing_risk_titles.add(title)

    existing_questions = {item.question for item in result.open_questions}
    for question in questions[:8]:
        if question not in existing_questions:
            result.open_questions.append(
                _question(
                    question=question,
                    reason="Kimi 分块抽取认为该点仍需访谈确认。",
                    owner_role="业务负责人/FDE",
                    now=now,
                )
            )
            existing_questions.add(question)

    if requirements and result.requirements:
        result.requirements[0].business_rules = _dedupe(result.requirements[0].business_rules + requirements[:6])
    return result


def _fact_strings(chunk_facts: list[dict[str, Any]], key: str) -> list[str]:
    values: list[str] = []
    for chunk in chunk_facts:
        raw_values = chunk.get(key)
        if isinstance(raw_values, list):
            values.extend(str(value).strip() for value in raw_values if str(value).strip())
        elif isinstance(raw_values, str) and raw_values.strip():
            values.append(raw_values.strip())
    return _dedupe(values)


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        key = re.sub(r"\s+", "", value)
        if not key or key in seen:
            continue
        seen.add(key)
        output.append(value)
    return output


def _join_compact(values: list[str]) -> str:
    return "；".join(value.rstrip("。；") for value in values if value.strip()) + "。"


def _schema_hint() -> dict[str, Any]:
    return {
        "prd": {
            "product_brief": {
                "name": "产品名",
                "positioning": "一句话定位",
                "target_users": ["目标用户"],
                "problem_statement": "解决的问题",
                "value_proposition": "核心价值",
                "scope": ["本期范围"],
                "out_of_scope": ["暂不做范围"],
            },
            "user_roles": ["角色"],
            "user_journeys": [{"actor": "角色", "trigger": "触发", "steps": ["步骤"], "expected_outcome": "结果"}],
            "feature_modules": [{"name": "模块", "goal": "目标", "core_capabilities": ["能力"], "related_requirements": ["需求标题"]}],
            "data_model": ["核心数据对象"],
            "success_metrics": ["成功指标"],
            "transcript_corrections": ["ASR 纠错"],
        },
        "requirements": [
            {
                "title": "短标题",
                "description": "可开发需求描述",
                "type": "functional|non_functional|integration|permission|data|deployment",
                "priority": "must|should|could",
                "module": "所属功能模块",
                "user_story": "作为某类用户，我希望完成某事，以便获得某价值",
                "business_rules": ["业务规则或边界条件"],
                "data_entities": ["涉及的数据对象"],
                "dependencies": ["依赖系统/模型/人工流程"],
                "evidence": "纠错后的转写证据",
                "acceptance_criteria": ["可验收标准"],
                "confidence": 0.9,
            }
        ],
        "risks": [{"title": "风险", "description": "说明", "severity": "low|medium|high", "mitigation": "缓解方式", "evidence": "证据"}],
        "open_questions": [{"question": "待确认问题", "reason": "为什么要问", "owner_role": "建议询问对象"}],
    }


def _local_prd_result(
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript_text: str,
    corrections: list[str],
    message: str,
) -> AnalysisResult:
    return _template_guided_result(session, template, transcript_text, corrections, message)


def _template_guided_result(
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript_text: str,
    corrections: list[str],
    message: str,
) -> AnalysisResult:
    now = utc_now()
    prd = PrdOutline(
        product_brief=ProductBrief(
            name=session.project_name,
            positioning=f"{template.domain} 场景的 FDE 需求分析草稿。",
            target_users=template.roles,
            problem_statement=_first_sentence(transcript_text) or "访谈已记录，但仍需要补齐业务流程和验收口径。",
            value_proposition="把口语访谈整理为可追问、可开发、可验收的需求条目。",
            scope=template.extraction_targets,
            out_of_scope=[],
        ),
        user_roles=template.roles,
        data_model=["访谈转写", "需求项", "风险", "未决问题", "验收标准"],
        success_metrics=template.acceptance_patterns,
        transcript_corrections=corrections,
    )
    requirements = [
        RequirementItem(
            id=f"req_{uuid.uuid4().hex[:10]}",
            title=f"{target}结构化补齐",
            description=f"围绕 {target} 把访谈中的角色、触发条件、系统动作、数据对象和验收口径补齐为 PRD 条目。",
            type=_requirement_type(target),
            priority="should",
            module=target,
            user_story=f"作为 FDE，我需要把 {target} 转成可开发需求，以便后续生成 PRD 和任务拆解。",
            business_rules=["低置信信息进入未决问题", "不得把模板问题直接当作业务事实"],
            data_entities=["访谈事实", "验收标准", "业务规则"],
            dependencies=["后续追问", "LLM 分析"],
            evidence=_first_sentence(transcript_text),
            acceptance_criteria=[f"{target}有明确角色、流程、边界和验收标准"],
            confidence=0.45,
            created_at=now,
        )
        for target in (template.extraction_targets or ["功能需求", "非功能需求", "集成需求"])
        if target != "风险"
    ]
    questions = [
        _question(question, "模板必问问题需要从访谈中确认后才能写入 PRD。", template.roles[0] if template.roles else "业务负责人", now)
        for question in template.required_questions[:8]
    ]
    return AnalysisResult(
        session_id=session.id,
        prd=prd,
        requirements=requirements,
        risks=[_risk("需求事实仍需确认", "当前仅能生成模板引导型分析，需要继续追问关键业务流程和验收指标。", "medium", "按未决问题继续访谈。", _first_sentence(transcript_text), now)],
        open_questions=questions,
        engine="local-prd-extractor:template-guided",
        status="fallback",
        message=message,
    )


def _parse_payload(session_id: str, payload: dict[str, Any], engine: str, status: str, message: str) -> AnalysisResult:
    now = utc_now()
    prd = _parse_prd(payload.get("prd"))
    requirements = [
        RequirementItem(
            id=f"req_{uuid.uuid4().hex[:10]}",
            title=str(item.get("title", "未命名需求")),
            description=str(item.get("description", "")) or str(item.get("title", "未命名需求")),
            type=_clean_requirement_type(item.get("type")),
            priority=_clean_priority(item.get("priority")),
            module=str(item.get("module", "")),
            user_story=str(item.get("user_story", "")),
            business_rules=[str(value) for value in item.get("business_rules", []) if str(value).strip()],
            data_entities=[str(value) for value in item.get("data_entities", []) if str(value).strip()],
            dependencies=[str(value) for value in item.get("dependencies", []) if str(value).strip()],
            evidence=str(item.get("evidence", "")),
            acceptance_criteria=[str(value) for value in item.get("acceptance_criteria", []) if str(value).strip()],
            confidence=float(item.get("confidence", 0.5)),
            created_at=now,
        )
        for item in _list_of_dicts(payload.get("requirements"))
        if str(item.get("title", "")).strip()
    ]
    risks = [
        _risk(
            title=str(item.get("title", "未命名风险")),
            description=str(item.get("description", "")) or str(item.get("title", "未命名风险")),
            severity=_clean_severity(item.get("severity")),
            mitigation=str(item.get("mitigation", "")),
            evidence=str(item.get("evidence", "")),
            now=now,
        )
        for item in _list_of_dicts(payload.get("risks"))
    ]
    open_questions = [
        _question(
            question=str(item.get("question", "待确认问题")),
            reason=str(item.get("reason", "")),
            owner_role=str(item.get("owner_role", "")),
            now=now,
        )
        for item in _list_of_dicts(payload.get("open_questions"))
    ]
    return AnalysisResult(
        session_id=session_id,
        prd=prd,
        requirements=requirements,
        risks=risks,
        open_questions=open_questions,
        engine=engine,
        status=status,  # type: ignore[arg-type]
        message=message,
    )


def _parse_prd(value: object) -> PrdOutline:
    if not isinstance(value, dict):
        return PrdOutline()
    product_brief = ProductBrief.model_validate(value.get("product_brief") if isinstance(value.get("product_brief"), dict) else {})
    journeys = [UserJourneyStep.model_validate(item) for item in _list_of_dicts(value.get("user_journeys"))]
    modules = [FeatureModule.model_validate(item) for item in _list_of_dicts(value.get("feature_modules"))]
    return PrdOutline(
        product_brief=product_brief,
        user_roles=[str(item) for item in value.get("user_roles", [])],
        user_journeys=journeys,
        feature_modules=modules,
        data_model=[str(item) for item in value.get("data_model", [])],
        success_metrics=[str(item) for item in value.get("success_metrics", [])],
        transcript_corrections=[str(item) for item in value.get("transcript_corrections", [])],
    )


def _chunk_text(text: str, max_chars: int, overlap: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + max_chars)
        chunks.append(text[start:end])
        if end == len(text):
            break
        start = max(0, end - overlap)
    return chunks


def _empty_fallback_result(session_id: str, template: ScenarioTemplate, message: str) -> AnalysisResult:
    now = utc_now()
    return AnalysisResult(
        session_id=session_id,
        prd=PrdOutline(
            product_brief=ProductBrief(
                name="",
                positioning="暂无有效转写，不能生成 PRD。",
                target_users=template.roles,
                problem_statement="访谈转写为空。",
                value_proposition="",
                scope=template.extraction_targets,
            )
        ),
        requirements=[],
        risks=[_risk("转写为空", "没有可分析的访谈文本。", "medium", "先完成录音和 ASR。", "", now)],
        open_questions=[],
        engine="local-fallback",
        status="fallback",
        message=message,
    )


def _requirement_type(target: str) -> str:
    if "非功能" in target or "指标" in target:
        return "non_functional"
    if "集成" in target:
        return "integration"
    if "权限" in target:
        return "permission"
    if "数据" in target:
        return "data"
    return "functional"


def _clean_requirement_type(value: object) -> str:
    allowed = {"functional", "non_functional", "integration", "permission", "data", "deployment"}
    text = str(value or "functional")
    return text if text in allowed else "functional"


def _clean_priority(value: object) -> str:
    text = str(value or "should")
    return text if text in {"must", "should", "could"} else "should"


def _clean_severity(value: object) -> str:
    text = str(value or "medium")
    return text if text in {"low", "medium", "high"} else "medium"


def _list_of_dicts(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _risk(title: str, description: str, severity: str, mitigation: str, evidence: str, now: Any) -> RiskItem:
    return RiskItem(
        id=f"risk_{uuid.uuid4().hex[:10]}",
        title=title,
        description=description,
        severity=_clean_severity(severity),  # type: ignore[arg-type]
        mitigation=mitigation,
        evidence=evidence,
        created_at=now,
    )


def _question(question: str, reason: str, owner_role: str, now: Any) -> OpenQuestionItem:
    return OpenQuestionItem(
        id=f"q_{uuid.uuid4().hex[:10]}",
        question=question,
        reason=reason,
        owner_role=owner_role,
        created_at=now,
    )


def _first_sentence(text: str) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return ""
    return compact[:180]
