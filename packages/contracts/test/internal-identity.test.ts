import test from 'node:test';
import assert from 'node:assert/strict';
import { signInternalIdentity, verifyInternalIdentity } from '../src/internal-identity';

const secret = process.env.INTERNAL_SERVICE_SECRET || 'dummy-test-key-for-unit-tests-only';
const claims = {
    typ: 'internal_identity' as const,
    sub: '507f1f77bcf86cd799439011',
    workspaceId: '507f191e810c19729de860ea',
    workspaceRole: 'owner',
    systemRole: 'user',
    permissions: ['campaigns:create'],
    requestId: 'request-1',
};

test('verifies issuer, audience, signature, and tenant claims', () => {
    const token = signInternalIdentity(claims, secret, 'campaign');
    assert.equal(verifyInternalIdentity(token, secret, 'campaign').workspaceId, claims.workspaceId);
    assert.throws(() => verifyInternalIdentity(token, secret, 'billing'));
    assert.throws(() => verifyInternalIdentity(token, `${secret}-wrong`, 'campaign'));
});