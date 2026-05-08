export function isActiveSidebarEntry(ps: {
  isStreaming: boolean;
  phaseStatus: string;
}): boolean {
  return ps.isStreaming || ps.phaseStatus === 'running';
}
