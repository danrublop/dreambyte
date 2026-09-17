// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { checkApiPermission, type WorldStateMutable } from './tool-executor'
import type { APIName, APIPermissions, PermissionConfig, PermissionMode, PermissionRule } from '../types/permissions'

function denyRule(api: APIName): PermissionRule {
  return {
    id: 'r1',
    scope: 'user',
    userId: 'u1',
    workspaceId: null,
    projectId: null,
    conversationId: null,
    decision: 'deny',
    api,
    specifier: null,
    costCapUsd: null,
    expiresAt: null,
    createdAt: new Date(0),
    createdBy: 'user-settings',
    notes: null,
  }
}

/**
 * Truth table for the agentRunMode posture layer added to checkApiPermission.
 *
 *   mode      provider=deny   provider=allow   provider=ask    demo
 *   auto      DENY (wins)     allow            allow           blocked (fail-closed)
 *   ask       DENY (wins)     ASK              ASK             blocked
 *   default   <existing rule/enum path — unchanged>
 *   demo: paid api → err (no spend); free stock search (unsplash) → NOT blocked
 *
 * checkApiPermission returns:
 *   null                       → allowed (run the call)
 *   { permissionNeeded }       → ask (surface the GenerationConfirmCard)
 *   { error, !permissionNeeded } → denied / blocked
 */

function cfg(mode: PermissionMode, caps?: Partial<PermissionConfig>): PermissionConfig {
  return { mode, sessionLimit: null, monthlyLimit: null, sessionSpend: 0, monthlySpend: 0, ...caps }
}

function world(opts: {
  api: APIName
  mode: PermissionMode
  sandboxMode?: boolean
  permissionPosture?: WorldStateMutable['permissionPosture']
  sessionAllow?: boolean
  caps?: Partial<PermissionConfig>
  rules?: PermissionRule[]
}): WorldStateMutable {
  return {
    apiPermissions: { [opts.api]: cfg(opts.mode, opts.caps) } as unknown as APIPermissions,
    sandboxMode: opts.sandboxMode,
    permissionPosture: opts.permissionPosture,
    sessionPermissions: opts.sessionAllow ? { [opts.api]: 'allow' } : undefined,
    // Rules only evaluate when an auth user is present (matches production wiring).
    ...(opts.rules ? { permissionRules: opts.rules, authUserId: 'u1' } : {}),
  } as unknown as WorldStateMutable
}

// checkApiPermission is async (it may re-hydrate live per-api spend from the ledger). These
// helpers take the RESOLVED value; call sites await the gate before passing it in.
type Resolved = Awaited<ReturnType<typeof checkApiPermission>>
const ask = (r: Resolved) => !!r && 'permissionNeeded' in r && !!r.permissionNeeded
const blocked = (r: Resolved) => !!r && !('permissionNeeded' in r && r.permissionNeeded)
const allowed = (r: Resolved) => r === null

describe('checkApiPermission — agentRunMode posture', () => {
  describe('Auto posture', () => {
    it('allows an ask-configured provider (auto overrides ask)', async () => {
      expect(
        allowed(
          await checkApiPermission(world({ api: 'imageGen', mode: 'always_ask', permissionPosture: 'auto' }), 'imageGen'),
        ),
      ).toBe(true)
    })

    it('allows an allow-configured provider', async () => {
      expect(
        allowed(
          await checkApiPermission(
            world({ api: 'imageGen', mode: 'always_allow', permissionPosture: 'auto' }),
            'imageGen',
          ),
        ),
      ).toBe(true)
    })

    it('DENY wins: an explicit always_deny provider is blocked even in Auto', async () => {
      const r = await checkApiPermission(
        world({ api: 'heygen', mode: 'always_deny', permissionPosture: 'auto' }),
        'heygen',
      )
      expect(blocked(r)).toBe(true)
      expect(ask(r)).toBe(false)
    })

    it('spend caps still apply in Auto — a reached session cap blocks (no silent bypass)', async () => {
      const r = await checkApiPermission(
        world({
          api: 'imageGen',
          mode: 'always_allow',
          permissionPosture: 'auto',
          caps: { sessionLimit: 5, sessionSpend: 5 },
        }),
        'imageGen',
      )
      expect(blocked(r)).toBe(true)
    })

    it('a reached monthly cap blocks in Auto', async () => {
      const r = await checkApiPermission(
        world({
          api: 'imageGen',
          mode: 'always_allow',
          permissionPosture: 'auto',
          caps: { monthlyLimit: 20, monthlySpend: 20 },
        }),
        'imageGen',
      )
      expect(blocked(r)).toBe(true)
    })

    it('under the cap, Auto allows', async () => {
      const r = await checkApiPermission(
        world({
          api: 'imageGen',
          mode: 'always_allow',
          permissionPosture: 'auto',
          caps: { sessionLimit: 5, sessionSpend: 1 },
        }),
        'imageGen',
      )
      expect(allowed(r)).toBe(true)
    })

    it('a layered rule DENY wins in Auto (rules supersede posture)', async () => {
      const r = await checkApiPermission(
        world({ api: 'imageGen', mode: 'always_allow', permissionPosture: 'auto', rules: [denyRule('imageGen')] }),
        'imageGen',
      )
      expect(blocked(r)).toBe(true)
      expect(ask(r)).toBe(false)
    })
  })

  describe('Ask posture', () => {
    it('asks for an allow-configured provider (ask wins over allow)', async () => {
      expect(
        ask(
          await checkApiPermission(world({ api: 'imageGen', mode: 'always_allow', permissionPosture: 'ask' }), 'imageGen'),
        ),
      ).toBe(true)
    })

    it('asks for an ask-configured provider', async () => {
      expect(
        ask(
          await checkApiPermission(world({ api: 'imageGen', mode: 'always_ask', permissionPosture: 'ask' }), 'imageGen'),
        ),
      ).toBe(true)
    })

    it('DENY wins over Ask too', async () => {
      expect(
        blocked(
          await checkApiPermission(world({ api: 'heygen', mode: 'always_deny', permissionPosture: 'ask' }), 'heygen'),
        ),
      ).toBe(true)
    })

    it('a prior session-allow suppresses the prompt (cheap call under threshold)', async () => {
      // unsplash has a null threshold (free) so a session-allow always suppresses.
      expect(
        allowed(
          await checkApiPermission(
            world({ api: 'unsplash', mode: 'always_ask', permissionPosture: 'ask', sessionAllow: true }),
            'unsplash',
          ),
        ),
      ).toBe(true)
    })
  })

  describe('Sandbox (fail-closed)', () => {
    it('blocks a paid provider that reaches the permission check (gateway bypass)', async () => {
      const r = await checkApiPermission(world({ api: 'imageGen', mode: 'always_allow', sandboxMode: true }), 'imageGen')
      expect(blocked(r)).toBe(true)
      expect(ask(r)).toBe(false)
    })

    it('blocks even when the provider config is missing (no allow-shortcut leak)', async () => {
      const r = await checkApiPermission({ sandboxMode: true } as unknown as WorldStateMutable, 'veo3')
      expect(blocked(r)).toBe(true)
    })

    it('does NOT block free stock search (unsplash) in Sandbox', async () => {
      // unsplash is exempt; with an allow config it should pass through (allowed).
      const r = await checkApiPermission(world({ api: 'unsplash', mode: 'always_allow', sandboxMode: true }), 'unsplash')
      expect(allowed(r)).toBe(true)
    })
  })

  describe('default posture leaves existing behavior intact', () => {
    it('always_allow → allowed (no posture set)', async () => {
      expect(allowed(await checkApiPermission(world({ api: 'imageGen', mode: 'always_allow' }), 'imageGen'))).toBe(true)
    })

    it('no apiPermissions at all → allowed (legacy/MCP runs)', async () => {
      expect(allowed(await checkApiPermission({} as unknown as WorldStateMutable, 'imageGen'))).toBe(true)
    })
  })
})
