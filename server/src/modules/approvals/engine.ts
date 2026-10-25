import { and, desc, eq, lte } from 'drizzle-orm';
import type { ApprovalEntityType } from '@shared/domain';
import { t, type DbOrTx, type Tx } from '../../db';
import type { Ctx } from '../../core/context';
import { forbidden, invalidState, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import { notify } from '../alerts/notify';

export interface ApprovalHandler {
  approve: (tx: Tx, ctx: Ctx, entityId: string) => Promise<void>;
  reject: (tx: Tx, ctx: Ctx, entityId: string, comment: string) => Promise<void>;
}
const handlers = new Map<string, ApprovalHandler>();

/** Domain modules register what happens when their approval is decided. */
export function registerApprovalHandler(entityType: ApprovalEntityType, handler: ApprovalHandler): void {
  handlers.set(entityType, handler);
}

/** Returns the strictest active rule the amount exceeds, or null if no approval is needed. */
export async function findApplicableRule(dbx: DbOrTx, tenantId: string, entityType: ApprovalEntityType, amount: number) {
  const [rule] = await dbx.select().from(t.approvalRules)
    .where(and(eq(t.approvalRules.tenantId, tenantId), eq(t.approvalRules.entityType, entityType), eq(t.approvalRules.active, 'true'), lte(t.approvalRules.threshold, Math.abs(amount))))
    .orderBy(desc(t.approvalRules.threshold))
    .limit(1);
  return rule ?? null;
}

export interface ApprovalRequestInput {
  entityType: ApprovalEntityType;
  entityId: string;
  entityNumber: string;
  amount: number;
  summary: string;
  rule: { id: string | null; approverRoleKey: string };
}

export async function createApprovalRequest(tx: DbOrTx, ctx: Ctx, input: ApprovalRequestInput): Promise<string> {
  const [req] = await tx.insert(t.approvalRequests).values({
    tenantId: ctx.tenantId,
    entityType: input.entityType,
    entityId: input.entityId,
    entityNumber: input.entityNumber,
    ruleId: input.rule.id,
    approverRoleKey: input.rule.approverRoleKey,
    amount: Math.abs(input.amount),
    summary: input.summary,
    requestedBy: ctx.userId || null,
  }).returning({ id: t.approvalRequests.id });
  await notify(tx, ctx.tenantId, {
    severity: 'warning',
    category: 'approval',
    title: `Approval needed: ${input.entityNumber}`,
    body: input.summary,
    entityType: input.entityType,
    entityId: input.entityId,
    actionUrl: '/approvals',
    permission: 'approval.decide',
    dedupeKey: `approval:${req!.id}`,
  });
  return req!.id;
}

/** Owners can decide anything; others must hold the approver role. No self-approval except owners. */
export function canDecide(ctx: Ctx, request: { approverRoleKey: string; requestedBy: string | null }): boolean {
  if (!ctx.permissions.has('approval.decide')) return false;
  if (ctx.roleKey === 'owner') return true;
  if (request.requestedBy === ctx.userId) return false;
  return ctx.roleKey === request.approverRoleKey;
}

export async function decideApproval(tx: Tx, ctx: Ctx, requestId: string, decision: 'approved' | 'rejected', comment: string): Promise<void> {
  const [request] = await tx.select().from(t.approvalRequests)
    .where(and(eq(t.approvalRequests.id, requestId), eq(t.approvalRequests.tenantId, ctx.tenantId))).for('update').limit(1);
  if (!request) throw notFound('Approval request');
  if (request.status !== 'pending') throw invalidState('This request has already been decided.');
  if (!canDecide(ctx, request)) {
    throw forbidden(request.requestedBy === ctx.userId ? 'You cannot approve your own request.' : `This request must be decided by a ${request.approverRoleKey.replace('_', ' ')}.`);
  }
  const handler = handlers.get(request.entityType);
  if (!handler) throw invalidState(`No approval handler for ${request.entityType}.`);
  await tx.update(t.approvalRequests).set({ status: decision, decidedBy: ctx.userId, decidedAt: new Date(), comment })
    .where(eq(t.approvalRequests.id, requestId));
  if (decision === 'approved') await handler.approve(tx, ctx, request.entityId);
  else await handler.reject(tx, ctx, request.entityId, comment);
  await tx.update(t.notifications).set({ resolvedAt: new Date() })
    .where(and(eq(t.notifications.tenantId, ctx.tenantId), eq(t.notifications.dedupeKey, `approval:${requestId}`)));
  await audit(tx, ctx, { action: `approval.${decision}`, entityType: request.entityType, entityId: request.entityId, newValue: { requestId, comment, amount: request.amount } });
}
