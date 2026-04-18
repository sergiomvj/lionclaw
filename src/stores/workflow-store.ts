// @deprecated - migrado para pipeline-engine/pipeline-store
import { create } from 'zustand';

export type WorkflowPhase = 'discovery' | 'generating' | 'done';

export interface WorkflowMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  agent?: string;
}

function questionToNumber(q: string): number {
  const match = q.match(/^Q(\d+)$/);
  if (match) return parseInt(match[1], 10);
  // PITCH_VALIDATION e SUMMARY_VALIDATION sao pos-Q11
  return 11;
}

interface WorkflowState {
  isActive: boolean;
  workflowRunId: string | null;
  currentStage: number;
  currentQuestion: string;
  currentQuestionNumber: number;
  totalQuestions: number;
  phase: WorkflowPhase;
  notesContent: string;
  generationRound: number;
  maxRounds: number;
  specContent: string | null;
  validationContent: string | null;
  specPath: string | null;
  notesPath: string | null;
  validationPassed: boolean;
  discoveryComplete: boolean;
  messages: WorkflowMessage[];

  activate: (runId: string) => void;
  deactivate: () => void;
  setPhase: (phase: WorkflowPhase) => void;
  setStage: (stage: number) => void;
  setQuestion: (question: string, current: number, total: number) => void;
  setNotesContent: (content: string) => void;
  setGenerationRound: (round: number, max: number) => void;
  setSpecResult: (specPath: string, notesPath: string, passed: boolean, specContent: string, validationContent: string) => void;
  setDiscoveryComplete: (complete: boolean) => void;
  addMessage: (msg: WorkflowMessage) => void;
  clearMessages: () => void;
  rehydrate: (data: {
    workflowRunId: string;
    currentStage: number;
    currentQuestion: string;
    notesPath: string | null;
    status: string;
    messages: WorkflowMessage[];
  }) => void;
}

const initialState = {
  isActive: false,
  workflowRunId: null as string | null,
  currentStage: 1,
  currentQuestion: 'Q1',
  currentQuestionNumber: 1,
  totalQuestions: 11,
  phase: 'discovery' as WorkflowPhase,
  notesContent: '',
  generationRound: 0,
  maxRounds: 3,
  specContent: null as string | null,
  validationContent: null as string | null,
  specPath: null as string | null,
  notesPath: null as string | null,
  validationPassed: false,
  discoveryComplete: false,
  messages: [] as WorkflowMessage[],
};

export const useWorkflowStore = create<WorkflowState>((set) => ({
  ...initialState,

  activate: (runId: string) =>
    set({
      isActive: true,
      workflowRunId: runId,
      phase: 'discovery',
      currentStage: 1,
      currentQuestion: 'Q1',
      currentQuestionNumber: 1,
      totalQuestions: 11,
      discoveryComplete: false,
      messages: [],
    }),

  deactivate: () => set({ ...initialState }),

  setPhase: (phase) => set({ phase }),
  setStage: (stage) => set({ currentStage: stage }),
  setQuestion: (question, current, total) =>
    set({ currentQuestion: question, currentQuestionNumber: current, totalQuestions: total }),
  setNotesContent: (content) => set({ notesContent: content }),
  setGenerationRound: (round, max) => set({ generationRound: round, maxRounds: max }),
  setSpecResult: (specPath, notesPath, passed, specContent, validationContent) =>
    set({ specPath, notesPath, validationPassed: passed, specContent, validationContent }),
  setDiscoveryComplete: (complete) => set({ discoveryComplete: complete }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  clearMessages: () => set({ messages: [] }),
  rehydrate: (data) => set({
    isActive: true,
    workflowRunId: data.workflowRunId,
    currentStage: data.currentStage,
    currentQuestionNumber: questionToNumber(data.currentQuestion),
    currentQuestion: data.currentQuestion,
    phase: data.status === 'generating' ? 'generating' : 'discovery',
    notesPath: data.notesPath,
    messages: data.messages,
  }),
}));
