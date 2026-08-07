import type { WorkspaceRole } from "./types.js";

/**
 * Roles form a deterministic capability ladder. Models never participate in
 * authorization and callers cannot turn an absent membership into a fallback.
 */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  contributor: 1,
  editor: 2,
  strategist: 3,
  admin: 4,
  owner: 5,
};

export class WorkspaceAccessError extends Error {
  readonly code = "WORKSPACE_ACCESS_DENIED";

  constructor(message = "You do not have access to this workspace.") {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

export function roleAtLeast(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function assertWorkspaceRole(actual: WorkspaceRole | null | undefined, required: WorkspaceRole): void {
  if (!actual || !roleAtLeast(actual, required)) throw new WorkspaceAccessError();
}

