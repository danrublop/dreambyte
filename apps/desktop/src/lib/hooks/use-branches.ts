'use client'

import { useEffect, useState } from 'react'
import { useVideoStore } from '@/lib/store'
import type { BranchRecord } from '@/types/dreambyte-api'

export function useBranches(projectId: string | null | undefined): BranchRecord[] {
  const [branches, setBranches] = useState<BranchRecord[]>([])
  const branchListVersion = useVideoStore((s) => s.branchListVersion)

  // Eager draft model: every project (including a fresh draft) has a real DB
  // row, so branches.list resolves — no isDraftProject gate is needed.
  useEffect(() => {
    if (!projectId) return
    const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined
    if (!ipc) return
    ipc
      .list({ projectId })
      .then(({ branches: list }) => setBranches(list as BranchRecord[]))
      .catch(() => setBranches([]))
  }, [projectId, branchListVersion])

  return branches
}
