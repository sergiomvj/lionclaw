import type { GraphData } from '@/types';

/**
 * Fetches graph data from the backend via IPC.
 * The backend already returns structured GraphData, so this is a thin wrapper.
 */
export async function fetchGraphData(): Promise<GraphData> {
  return window.lionclaw.mgraph.graph();
}
