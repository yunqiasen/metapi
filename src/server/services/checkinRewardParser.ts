function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

function positiveAmount(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function parseCheckinRewardAmount(value: unknown): number {
  const numeric = toFiniteNumber(value);
  if (numeric != null) {
    return numeric > 0 ? numeric : 0;
  }

  if (typeof value !== 'string') return 0;
  const text = value.trim();
  if (!text) return 0;

  const normalized = text.replace(/,/g, '');
  if (/额度无新增|无新增额度|quota\s+(?:is\s+)?unchanged|no\s+(?:new\s+)?(?:reward|quota|credit)/i.test(normalized)) {
    return 0;
  }

  const explicitIncrease = normalized.match(/(?:\+\s*\$?|\$\s*\+)\s*(\d+(?:\.\d+)?)/);
  const explicitIncreaseAmount = positiveAmount(explicitIncrease?.[1]);
  if (explicitIncreaseAmount > 0) return explicitIncreaseAmount;

  const labeledReward = normalized.match(
    /(?:reward|bonus|credited?|奖励|获得|到账|增加|增量|赠送)\s*(?:[:=：]|为)?\s*\$?\s*\+?\s*(\d+(?:\.\d+)?)/i,
  );
  return positiveAmount(labeledReward?.[1]);
}
