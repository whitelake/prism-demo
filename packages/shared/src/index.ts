export type AssessmentStage =
  | 'examiner'
  | 'questionnaire'
  | 'tool'
  | 'pending_interview'
  | 'interview'
  | 'final_evaluating'
  | 'completed';

export type AssessmentLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export type AssessmentTrack = 'A' | 'B' | 'C';
