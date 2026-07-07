/**
 * Thin seam so evidence producers (uploads, reports) can trigger a re-verification of an
 * object WITHOUT a hard dependency on the verification internals. VerificationModule binds
 * this token to VerificationService; consumers inject it @Optional() so they still work
 * (and their tests pass) when it isn't provided.
 */
export const VERIFICATION_HOOK = 'VERIFICATION_HOOK';

export interface VerificationHook {
  verifyObject(tenantId: string, objectId: string): Promise<unknown>;
}
