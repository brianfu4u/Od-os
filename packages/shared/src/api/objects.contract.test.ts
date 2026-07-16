import { describe, it, expectTypeOf } from 'vitest';
import type { CreateObjectInput, UpdateObjectInput } from './objects.contract';

/**
 * P0-1 contract lock: the public object WRITE DTOs must never expose the verdict fields. If someone
 * re-adds `verifiedState` / `verificationScore` to CreateObjectInput or UpdateObjectInput, this fails to
 * type-check (vitest runs it under tsc), catching the regression before it can reach an endpoint.
 * The verdict is owned exclusively by the deterministic S2 Verification Service.
 */
describe('objects write DTOs exclude the S2 verdict fields (P0-1)', () => {
  it('CreateObjectInput has no verifiedState/verificationScore', () => {
    expectTypeOf<CreateObjectInput>().not.toHaveProperty('verifiedState');
    expectTypeOf<CreateObjectInput>().not.toHaveProperty('verificationScore');
    expectTypeOf<CreateObjectInput>().not.toHaveProperty('confidence');
  });

  it('UpdateObjectInput has no verifiedState/verificationScore', () => {
    expectTypeOf<UpdateObjectInput>().not.toHaveProperty('verifiedState');
    expectTypeOf<UpdateObjectInput>().not.toHaveProperty('verificationScore');
    expectTypeOf<UpdateObjectInput>().not.toHaveProperty('confidence');
  });
});
