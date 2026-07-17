import { describe, expect, it, vi } from 'vitest';
import type { EmployeeStatusVerificationRepository } from './employee-status-verification.repository';
import { EmployeeStatusVerificationService } from './employee-status-verification.service';

const claimId = '11111111-1111-4111-8111-111111111111';

function setup() {
  const repository = {
    append: vi.fn().mockResolvedValue({ ledgerId: 'ledger-1', claimId, employeeId: 'employee-1' }),
  } as unknown as EmployeeStatusVerificationRepository;
  return { repository, service: new EmployeeStatusVerificationService(repository) };
}

describe('EmployeeStatusVerificationService', () => {
  it('passes a deterministic employee consistency verdict to the append bridge', async () => {
    const { repository, service } = setup();
    await service.append('tenant-1', {
      claimId,
      verificationResult: 'consistent',
      verificationScore: 0.6,
      evidence: { eventIds: ['event-1'] },
    });
    expect(repository.append).toHaveBeenCalledOnce();
  });

  it.each([null, 0, 0.59, 0.6, 1])('accepts the bounded deterministic score %s', async (score) => {
    const { service } = setup();
    await expect(
      service.append('tenant-1', {
        claimId,
        verificationResult: 'insufficient_evidence',
        verificationScore: score,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects the generic object-verification enum', () => {
    const { service } = setup();
    expect(() =>
      service.append('tenant-1', {
        claimId,
        verificationResult: 'verified',
        verificationScore: 0.9,
      } as never),
    ).toThrow('invalid employee-status verificationResult');
  });

  it('rejects llmConfidence instead of treating it as verificationScore', () => {
    const { service } = setup();
    expect(() =>
      service.append('tenant-1', {
        claimId,
        verificationResult: 'consistent',
        verificationScore: 0.9,
        llmConfidence: 0.9,
      } as never),
    ).toThrow('unknown verification field: llmConfidence');
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid verificationScore %s',
    (verificationScore) => {
      const { service } = setup();
      expect(() =>
        service.append('tenant-1', {
          claimId,
          verificationResult: 'consistent',
          verificationScore,
        }),
      ).toThrow('verificationScore must be a finite number in [0,1]');
    },
  );
});
