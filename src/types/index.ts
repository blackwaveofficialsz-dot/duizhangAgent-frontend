export type MessageRole = 'user' | 'assistant' | 'tool_call';
export * from './agentActivity';
import type { AgentActivity } from './agentActivity';
import type { AguiMessageState, ConversationMode } from './agui';
import { parseBeijingTime } from '../utils/time';
export type ToolCallStatus = 'loading' | 'completed' | 'failed';
export type MessageStageStatus = 'running' | 'completed' | 'failed';

export interface ToolCallData {
  name: string;
  description: string;
  status: ToolCallStatus;
}

export interface MessageStage {
  code: string;
  label: string;
  detail?: string;
  status: MessageStageStatus;
}

export interface ApprovalRequest {
  action: string;
  description: string;
  turnId: string;
}

export interface QueryEvidenceRowCounts {
  all: number | null;
  date_filtered: number | null;
  field_filtered: number | null;
  scope_filtered: number | null;
  returned: number;
  truncated: boolean;
}

export interface QueryEvidence {
  dataset_ids: string[];
  dataset_name: string;
  query_plan?: Record<string, unknown>;
  date_range: { from: string | null; to: string | null };
  scope: string;
  fields: string[];
  filters: { field: string; op: string; value: unknown }[];
  group_by: string[];
  metrics: string[];
  knowledge_entries: string[];
  row_counts: QueryEvidenceRowCounts;
  warnings: string[];
  augment_fields?: string[];
}

export interface AgentResponseMetric {
  key: string;
  value: string;
  label?: string;
  unit?: string;
}

export type AgentResponseStatementType = 'fact' | 'hypothesis' | 'recommendation';
export type AgentResponseNoticeSeverity = 'info' | 'warning' | 'error';

export interface AgentResponseInsight {
  statement_type: AgentResponseStatementType;
  text: string;
  evidence_refs: string[];
}

export interface AgentResponseAction {
  action_id: string;
  kind: string;
  label: string;
  result_id?: string;
  source_turn_id?: string;
  params?: Record<string, unknown>;
}

export interface ClarificationAnswer {
  option_id?: string;
  text?: string;
}

export interface ClarificationQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
  allow_free_text?: boolean;
}

export interface AgentResponsePart {
  kind: string;
  title?: string;
  message?: string;
  metrics?: AgentResponseMetric[];
  table_id?: string;
  row_count?: number;
  columns?: Array<{ key: string; label: string; data_type?: string; unit?: string }>;
  preview_rows?: Array<Record<string, unknown>>;
  items?: AgentResponseInsight[];
  severity?: AgentResponseNoticeSeverity;
  code?: string;
  clarification_id?: string;
  run_id?: string;
  questions?: ClarificationQuestion[];
  status?: 'pending' | 'answered' | 'expired' | 'cancelled';
  expires_at?: string;
  answers?: Record<string, ClarificationAnswer>;
}

export interface QuestionnairePart extends AgentResponsePart {
  kind: 'questionnaire';
  clarification_id: string;
  run_id: string;
  questions: ClarificationQuestion[];
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  expires_at: string;
}

export interface AgentResponsePayload {
  version: 1;
  domain: string;
  task: string;
  result_status: 'ok' | 'partial' | 'empty' | 'unavailable' | 'failed' | 'needs_confirmation';
  result_id: string;
  source_turn_id: string;
  parts: AgentResponsePart[];
  content?: string;
  reason_code?: string;
  message?: string;
  missing_date_count?: number;
  limitations?: Array<{ code: string; text: string }>;
  actions?: AgentResponseAction[];
}

export function parseAgentResponsePayload(value: unknown): AgentResponsePayload | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const resultStatus = value.result_status;
  if (
    typeof value.domain !== 'string'
    || typeof value.task !== 'string'
    || typeof resultStatus !== 'string'
    || !['ok', 'partial', 'empty', 'unavailable', 'failed', 'needs_confirmation'].includes(resultStatus)
    || typeof value.result_id !== 'string'
    || !isNonEmptyString(value.source_turn_id)
    || !Array.isArray(value.parts)
    || !value.parts.every(isAgentResponsePart)
    || (value.actions !== undefined && !isAgentResponseActions(value.actions, value.source_turn_id))
  ) return null;
  return value as unknown as AgentResponsePayload;
}

function isAgentResponsePart(value: unknown): value is AgentResponsePart {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) return false;
  const isBasePart = (
    (value.title === undefined || typeof value.title === 'string')
    && (value.message === undefined || typeof value.message === 'string')
    && (value.table_id === undefined || typeof value.table_id === 'string')
    && (value.row_count === undefined || (
      typeof value.row_count === 'number'
      && Number.isInteger(value.row_count)
      && value.row_count >= 0
    ))
    && (value.metrics === undefined || (Array.isArray(value.metrics) && value.metrics.every(isAgentResponseMetric)))
    && (value.columns === undefined || (Array.isArray(value.columns) && value.columns.every(isAgentResponseColumn)))
    && (value.preview_rows === undefined || (
      Array.isArray(value.preview_rows)
      && value.preview_rows.length <= 50
      && value.preview_rows.every(isRecord)
    ))
  );
  if (!isBasePart) return false;
  if (value.kind === 'questionnaire') return isQuestionnairePart(value);
  if (value.kind === 'summary') return value.metrics === undefined || (
    Array.isArray(value.metrics) && value.metrics.length <= 6
  );
  if (value.kind === 'insights') {
    return Array.isArray(value.items)
      && value.items.length <= 6
      && value.items.every(isAgentResponseInsight);
  }
  if (value.kind === 'notice') {
    return isNonEmptyString(value.message)
      && ['info', 'warning', 'error'].includes(value.severity as string)
      && isNonEmptyString(value.code);
  }
  return true;
}

export function isQuestionnairePart(value: unknown): value is QuestionnairePart {
  if (!isRecord(value)
    || value.kind !== 'questionnaire'
    || !isNonEmptyString(value.clarification_id)
    || !isNonEmptyString(value.run_id)
    || !['pending', 'answered', 'expired', 'cancelled'].includes(value.status as string)
    || !isNonEmptyString(value.expires_at)
    || !Number.isFinite(parseBeijingTime(value.expires_at))
    || !Array.isArray(value.questions)
    || value.questions.length < 1 || value.questions.length > 3
    || !value.questions.every(isClarificationQuestion)
    || new Set(value.questions.map((question) => question.id)).size !== value.questions.length
  ) return false;
  if (value.answers === undefined) return value.status !== 'answered';
  if (!isRecord(value.answers)) return false;
  const questions = value.questions;
  if (value.status === 'answered' && Object.keys(value.answers).length !== questions.length) return false;
  return Object.entries(value.answers).every(([questionId, answer]) => {
    const question = questions.find((item) => item.id === questionId);
    if (!question || !isRecord(answer) || Object.keys(answer).length !== 1) return false;
    return (isNonEmptyString(answer.option_id)
      && question.options.some((option) => option.id === answer.option_id))
      || (isNonEmptyString(answer.text) && (question.allow_free_text === true || question.options.length === 0));
  });
}

function isClarificationQuestion(value: unknown): value is ClarificationQuestion {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.header)
    && isNonEmptyString(value.question)
    && (value.allow_free_text === undefined || typeof value.allow_free_text === 'boolean')
    && Array.isArray(value.options)
    && (value.options.length === 0 || (value.options.length >= 2 && value.options.length <= 3))
    && value.options.every((option) => isRecord(option)
      && isNonEmptyString(option.id)
      && isNonEmptyString(option.label)
      && (option.description === undefined || typeof option.description === 'string')
      && (option.recommended === undefined || typeof option.recommended === 'boolean'))
    && new Set(value.options.map((option) => option.id)).size === value.options.length;
}

function isAgentResponseMetric(value: unknown): value is AgentResponseMetric {
  return isRecord(value)
    && isNonEmptyString(value.key)
    && typeof value.value === 'string'
    && (value.label === undefined || typeof value.label === 'string')
    && (value.unit === undefined || typeof value.unit === 'string');
}

function isAgentResponseColumn(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.key)
    && isNonEmptyString(value.label)
    && (value.data_type === undefined || typeof value.data_type === 'string')
    && (value.unit === undefined || typeof value.unit === 'string');
}

function isAgentResponseInsight(value: unknown): value is AgentResponseInsight {
  return isRecord(value)
    && ['fact', 'hypothesis', 'recommendation'].includes(value.statement_type as string)
    && isNonEmptyString(value.text)
    && Array.isArray(value.evidence_refs)
    && value.evidence_refs.every(isNonEmptyString)
    && (value.statement_type !== 'recommendation' || value.evidence_refs.length > 0);
}

function isAgentResponseActions(value: unknown, sourceTurnId: unknown): value is AgentResponseAction[] {
  return Array.isArray(value)
    && value.length <= 6
    && value.filter((action) => isRecord(action) && action.kind === 'prompt').length <= 3
    && value.filter((action) => isRecord(action) && action.kind === 'clarify').length <= 4
    && value.every((action) => isRecord(action)
      && isNonEmptyString(action.action_id)
      && isNonEmptyString(action.kind)
      && isNonEmptyString(action.label)
      && (action.result_id === undefined || typeof action.result_id === 'string')
      && (action.source_turn_id === undefined || typeof action.source_turn_id === 'string')
      && (action.params === undefined || isRecord(action.params))
      && (action.kind !== 'prompt' || (
        isNonEmptyString(action.source_turn_id)
        && action.source_turn_id === sourceTurnId
        && isRecord(action.params)
        && Object.keys(action.params).length === 1
        && Object.prototype.hasOwnProperty.call(action.params, 'message')
        && isNonEmptyString(action.params.message)
      ))
      && (action.kind !== 'clarify' || (
        isNonEmptyString(action.source_turn_id)
        && action.source_turn_id === sourceTurnId
        && isRecord(action.params)
        && Object.keys(action.params).length === 2
        && Object.prototype.hasOwnProperty.call(action.params, 'candidate_id')
        && Object.prototype.hasOwnProperty.call(action.params, 'message')
        && isNonEmptyString(action.params.candidate_id)
        && isNonEmptyString(action.params.message)
      )));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface KnowledgeSuggestion {
  dataset_id: string;
  dataset_name: string;
  kind: string;
  missing_term: string;
  category: string;
  title: string;
  content: string;
  available_fields: string[];
  message: string;
  editable_placeholder: string;
}

export interface QueryExportInfo {
  available: boolean;
  total: number;
  returned: number;
  truncated: boolean;
  dataset_name: string;
}

export interface KnowledgeContext {
  required?: unknown[];
  optional?: unknown[];
  missing?: unknown[];
  trace?: unknown[];
  suggestions?: string[];
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt?: number;
  toolCall?: ToolCallData;
  streaming?: boolean;
  agui?: AguiMessageState;
  stage?: MessageStage | null;
  activity?: AgentActivity | null;
  taskId?: string;
  agentResponse?: AgentResponsePayload | null;
  evidence?: QueryEvidence | null;
  knowledgeSuggestion?: KnowledgeSuggestion | null;
  queryExport?: QueryExportInfo | null;
  knowledgeContext?: KnowledgeContext | null;
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  pending?: boolean;
  loaded?: boolean;
  conversationMode?: ConversationMode;
}

export interface FileSet {
  files: File[];
  period?: string;
  replace?: boolean;
  taskType?: 'file_parsing' | 'reconciliation';
}

export type ChatInteraction = {
  kind: 'clarification_choice';
  source_turn_id: string;
  candidate_id: string;
} | {
  kind: 'clarification_answer';
  source_turn_id: string;
  run_id: string;
  clarification_id: string;
  answers: Record<string, ClarificationAnswer>;
};

export interface KbEntry {
  id: string;
  title: string;
  content: string;
  category: string;
  source: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ReconcileTemplateSummary {
  id: string;
  provider: string;
  title: string;
  platform_name: string;
  file_keywords: string[];
  sheet_count: number;
  field_count: number;
  source: string;
  updated_at: string;
}

export interface SeedImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface ReconcileTemplateDraft {
  provider: string;
  template: Record<string, unknown>;
  summary: ReconcileTemplateSummary;
}

export interface SalaryTemplateSummary {
  id: string;
  name: string;
  source_file: string;
  sheet_count: number;
  input_count: number;
  formula_count: number;
  source: string;
  updated_at: string;
}

export interface SalaryTemplateDraft {
  name: string;
  template: Record<string, unknown>;
  summary: string;
  sheet_count: number;
  input_count: number;
  formula_count: number;
}

export interface ReportTemplateSummary {
  id: string;
  template_type: string;
  template_label: string;
  original_filename: string;
  sheet_count: number;
  has_global_instruction?: boolean;
  has_template_instruction?: boolean;
  instruction_updated_at?: string;
  updated_at: string;
}

export interface ReportTemplateDetail extends ReportTemplateSummary {
  file_path?: string;
  sheets?: Array<Record<string, unknown>>;
  global_instruction?: {
    text?: string;
    rules?: Array<Record<string, unknown>>;
    items?: Array<{
      id?: string;
      text?: string;
      rules?: Array<Record<string, unknown>>;
      original_filename?: string;
      updated_at?: string;
    }>;
    original_filename?: string;
    updated_at?: string;
  } | null;
  template_instruction?: {
    text?: string;
    rules?: Array<Record<string, unknown>>;
    items?: Array<{
      id?: string;
      text?: string;
      rules?: Array<Record<string, unknown>>;
      original_filename?: string;
      updated_at?: string;
    }>;
    original_filename?: string;
    updated_at?: string;
  } | null;
}

export interface KnowledgeReadinessItem {
  code: string;
  title: string;
  message: string;
  category: string;
  blocking: boolean;
  suggested_title?: string;
  example_content?: string;
}

export interface KnowledgeReadiness {
  context: string;
  status: 'ready' | 'warning' | 'blocked';
  blocking_items: KnowledgeReadinessItem[];
  warnings: KnowledgeReadinessItem[];
  suggested_kb_entries: KnowledgeReadinessItem[];
  satisfied: string[];
}

export interface ExtractedFact {
  title: string;
  content: string;
  category: string;
}

// ── Admin types ──

export interface AdminUser {
  id: string;
  username: string;
  tenant_id: string | null;
  role: string;
  must_change_password: boolean;
  created_at: string;
}

export interface AdminTenant {
  id: string;
  brand_name: string;
  tenant_code: string;
  store_count: number;
  model_provider: string;
  model_name: string;
  is_new_tenant: string;
  user_count: number;
  created_at: string;
}
