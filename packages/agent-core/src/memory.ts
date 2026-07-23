import type {
  UserMemory,
  UserMemoryCandidate,
  UserMemoryKind,
  UserMemorySourceType
} from "@tomeet/contracts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const MEMORY_RETENTION_DAYS: Readonly<Partial<Record<UserMemoryKind, number>>> = {
  temporary_state: 14,
  multimodal_impression: 30,
  social_learning: 180
};

const sensitivePatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:\+?\d[\d\s().-]{7,}\d)/u,
  /\b(?:\d[ -]*?){12,19}\b/u,
  /\b(?:api[_ -]?key|access[_ -]?token|password|passport|social security|credit card|bank account)\b/iu,
  /(?:密码|密钥|令牌|身份证|护照|银行卡|信用卡|银行账户|精确地址|门牌号)/u,
  /(?:路|街|巷|弄|大道|小区|公寓|栋|单元)\s*\d{1,5}(?:号|室|栋|单元)?/u,
  /(?:病历|诊断|疾病|用药|医疗记录|宗教信仰|政治立场|党派|性取向|生物识别|人脸特征)/u
];

export interface MemorySanitizationResult {
  accepted: UserMemoryCandidate[];
  rejectedCount: number;
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}

export function truncateToEstimatedTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, Math.max(0, low - 1)).trimEnd()}…`;
}

export function containsSensitivePersonalData(text: string): boolean {
  return sensitivePatterns.some((pattern) => pattern.test(text));
}

export function defaultMemoryExpiration(
  kind: UserMemoryKind,
  now = new Date()
): string | null {
  const retentionDays = MEMORY_RETENTION_DAYS[kind];
  return retentionDays
    ? new Date(now.getTime() + retentionDays * DAY_MS).toISOString()
    : null;
}

function normalizeStableKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/gu, "_")
    .replace(/[^\p{L}\p{N}_:.-]/gu, "")
    .slice(0, 200);
}

export function sanitizeMemoryCandidates(
  candidates: UserMemoryCandidate[],
  sourceType: UserMemorySourceType,
  now = new Date()
): MemorySanitizationResult {
  const accepted: UserMemoryCandidate[] = [];
  let rejectedCount = 0;
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const stableKey = normalizeStableKey(candidate.stableKey);
    const content = candidate.content.trim();
    const kind = sourceType === "multimodal" ? "multimodal_impression" : candidate.kind;
    if (!stableKey || !content || containsSensitivePersonalData(content)) {
      rejectedCount += 1;
      continue;
    }

    const identity = `${kind}:${stableKey}:${content.toLocaleLowerCase()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const policyExpiration = defaultMemoryExpiration(kind, now);
    let expiresAt = candidate.expiresAt ?? policyExpiration;
    if (policyExpiration && expiresAt) {
      const maximum = new Date(policyExpiration).getTime();
      const requested = new Date(expiresAt).getTime();
      expiresAt = new Date(Math.min(maximum, requested)).toISOString();
    }
    accepted.push({ kind, stableKey, content, expiresAt });
    if (accepted.length === 8) break;
  }

  return { accepted, rejectedCount };
}

function queryTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const cjk = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)]
    .flatMap(([value]) => Array.from({ length: Math.max(0, value.length - 1) }, (_, index) =>
      value.slice(index, index + 2)
    ));
  return [...new Set([...words, ...cjk])].slice(0, 32);
}

export function selectRelevantMemories(
  memories: UserMemory[],
  queries: string[],
  limit = 6,
  now = new Date()
): UserMemory[] {
  const terms = queries.flatMap(queryTerms);
  const nowMs = now.getTime();
  return memories
    .filter((memory) =>
      memory.status === "active"
      && (!memory.expiresAt || new Date(memory.expiresAt).getTime() > nowMs)
    )
    .map((memory) => {
      const haystack = `${memory.stableKey} ${memory.content}`.toLocaleLowerCase();
      const lexical = terms.reduce((score, term) => score + (haystack.includes(term) ? 4 : 0), 0);
      const confirmed = Math.min(memory.confirmationCount, 5);
      const used = Math.min(memory.usageCount, 5) * 0.25;
      const freshness = Math.max(
        0,
        2 - (nowMs - new Date(memory.lastConfirmedAt).getTime()) / (90 * DAY_MS)
      );
      return { memory, score: lexical + confirmed + used + freshness };
    })
    .sort((left, right) =>
      right.score - left.score
      || right.memory.lastConfirmedAt.localeCompare(left.memory.lastConfirmedAt)
    )
    .slice(0, Math.min(Math.max(limit, 0), 6))
    .map(({ memory }) => memory);
}
