import { ForbiddenException, Injectable } from '@nestjs/common';
import type { EmployeeStatus, EmployeeStatusView, StatusBoardView } from '@clearview/shared';
import { RealtimeService } from '../objects/realtime.service';
import { EmployeeStatusRepository, NoStaffIdentityError } from './employee-status.repository';
import type { SessionIdentity } from '../auth/session.types';

/**
 * T-04 · employee work-status service. Thin orchestration over the repository (where the atomic,
 * RLS-scoped, three-in-one write lives). After a claim commits, publish a real-time BROADCAST so the
 * manager dashboard can refetch — the SSE carries NO business logic, just a nudge (原则: SSE 只播报).
 *
 * A missing staff identity becomes a 403 (the caller is authenticated but is not a staff member with
 * a resolvable object here) — never a silent no-op.
 */
@Injectable()
export class EmployeeStatusService {
  constructor(
    private readonly repo: EmployeeStatusRepository,
    private readonly realtime: RealtimeService,
  ) {}

  async submit(
    tenantId: string,
    identity: SessionIdentity | undefined,
    claimedStatus: EmployeeStatus,
    note: string | null,
    claimedAt: string | null,
  ): Promise<EmployeeStatusView> {
    let result;
    try {
      result = await this.repo.submitClaim(tenantId, identity, claimedStatus, note, claimedAt);
    } catch (err) {
      if (err instanceof NoStaffIdentityError) {
        throw new ForbiddenException('no staff identity for the caller');
      }
      throw err;
    }
    // Broadcast-only nudge for the manager dashboard. Target is the SERVER-RESOLVED Staff object id;
    // payload is thin (no business logic on the wire) — the manager client refetches its status board.
    this.realtime.publish({
      kind: 'updated',
      tenantId,
      objectId: result.employeeId,
      type: 'Staff',
      at: new Date().toISOString(),
    });
    return result.view;
  }

  async me(tenantId: string, identity: SessionIdentity | undefined): Promise<EmployeeStatusView> {
    try {
      return await this.repo.currentForCaller(tenantId, identity);
    } catch (err) {
      if (err instanceof NoStaffIdentityError) {
        throw new ForbiddenException('no staff identity for the caller');
      }
      throw err;
    }
  }

  /**
   * MANAGER-side whole-roster status board (T-09 · D1-A). Pure read: no write, no event, no world-state
   * mutation. Returns the CLAIM layer + read-time freshness OBSERVATION for every in-roster Staff.
   */
  async board(tenantId: string): Promise<StatusBoardView> {
    const rows = await this.repo.statusBoard(tenantId);
    return { rows };
  }
}
