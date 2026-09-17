import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  convergeAccountMutation,
  rebuildRoutesBestEffort,
} from './accountMutationWorkflow.js';
import { startBackgroundTask } from './backgroundTaskService.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';

type AccountUpdateWorkflowInput = {
  accountId: number;
  updates: Partial<typeof schema.accounts.$inferInsert>;
  preferredApiToken?: string | null;
  refreshModels: boolean;
  preserveExpiredStatus?: boolean;
  allowInactiveModelRefresh?: boolean;
  reactivateAfterSuccessfulModelRefresh?: boolean;
  continueOnError?: boolean;
};

// Preserve every save, but serialize maintenance so an older refresh cannot finish last.
const maintenanceByAccount = new Map<number, Promise<unknown>>();

async function maintainAccountAfterSave(input: AccountUpdateWorkflowInput) {
  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, input.accountId)).get();
  if (!account) return { convergence: null };

  const isExpiredApiKeyRecoveryFlow = Boolean(
    input.preserveExpiredStatus
    && input.allowInactiveModelRefresh
    && input.reactivateAfterSuccessfulModelRefresh,
  );
  const convergence = await convergeAccountMutation({
    accountId: input.accountId,
    // A queued save may already have a newer key. Never write a captured old key back.
    preferredApiToken: input.preferredApiToken && getCredentialModeFromExtraConfig(account.extraConfig) !== 'apikey'
      ? account.apiToken
      : null,
    defaultTokenSource: 'manual',
    refreshModels: input.refreshModels,
    allowInactiveModelRefresh: input.allowInactiveModelRefresh,
    rebuildRoutes: false,
    continueOnError: input.continueOnError,
  });

  if (
    input.reactivateAfterSuccessfulModelRefresh
    && convergence.modelRefreshResult?.status === 'success'
  ) {
    const latest = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, input.accountId)).get();
    if (
      latest?.status === 'expired'
      && latest.accessToken === account.accessToken
      && latest.apiToken === account.apiToken
      && latest.updatedAt
    ) {
      await db.update(schema.accounts)
        .set({ status: 'active', updatedAt: new Date().toISOString() })
        .where(and(
          eq(schema.accounts.id, input.accountId),
          eq(schema.accounts.updatedAt, latest.updatedAt),
          eq(schema.accounts.status, 'expired'),
        ))
        .run();
    }
  }

  const shouldRebuildRoutes = !isExpiredApiKeyRecoveryFlow
    || convergence.modelRefreshResult?.status === 'success';
  if (shouldRebuildRoutes) await rebuildRoutesBestEffort();

  const modelRefresh = convergence.modelRefreshResult;
  if (input.refreshModels && (!modelRefresh || modelRefresh.status === 'failed')) {
    throw new Error(modelRefresh?.errorMessage || '模型同步未完成');
  }
  return { convergence };
}

export async function applyAccountUpdateWorkflow(input: AccountUpdateWorkflowInput) {
  const persistedUpdates: Partial<typeof schema.accounts.$inferInsert> = {
    ...input.updates,
    ...(input.preserveExpiredStatus ? { status: 'expired' } : {}),
    updatedAt: new Date().toISOString(),
  };
  await db.update(schema.accounts)
    .set(persistedUpdates)
    .where(eq(schema.accounts.id, input.accountId))
    .run();

  // Capture the actual saved response before scheduling any slow network work.
  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, input.accountId)).get();

  const previous = maintenanceByAccount.get(input.accountId) || Promise.resolve();
  const maintenance = previous.catch(() => undefined).then(() => maintainAccountAfterSave(input));
  maintenanceByAccount.set(input.accountId, maintenance);
  void maintenance.finally(() => {
    if (maintenanceByAccount.get(input.accountId) === maintenance) {
      maintenanceByAccount.delete(input.accountId);
    }
  }).catch(() => undefined);

  const { task } = startBackgroundTask({
    type: 'account-update-maintenance',
    title: `账号 #${input.accountId} 保存后同步`,
    notifyOnFailure: false,
    successMessage: `账号 #${input.accountId} 保存后同步完成`,
    failureMessage: (currentTask) => `账号 #${input.accountId} 保存后同步失败：${currentTask.error || 'unknown error'}`,
  }, () => maintenance);

  return {
    account,
    maintenanceTask: { id: task.id, status: task.status },
  };
}
