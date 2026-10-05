export interface SetupDiagnosis {
  checkedAt: string;
  platform: string;
  arch: string;
  osVersion: string;
  memoryGB: number;
  freeDiskGB: number | null;
  desktopInstalled: boolean;
  docker: {
    reachable: boolean;
    engine: 'linux' | 'windows' | 'unknown';
    imagePresent: boolean | null;
  };
  container: {
    exists: boolean | null;
    managed: boolean;
    compatible: boolean;
    running: boolean;
    oomKilled: boolean;
    exitCode: number | null;
  };
  grobidHealthy: boolean;
  portOpen: boolean;
  wsl: 'not_applicable' | 'ready' | 'unavailable';
  virtualization: 'enabled' | 'disabled' | 'unknown';
  signals: string[];
  setupPhase: string;
  setupBusy: boolean;
  setupError: string | null;
}
export const REPAIR_ACTIONS = [
  'prepare',
  'open_docker',
  'install_wsl',
  'restart_grobid',
  'wait_user',
  'done',
] as const;
export type RepairAction = (typeof REPAIR_ACTIONS)[number];
export interface RepairDecision {
  explanation: string;
  action: RepairAction;
}
export interface RepairEntry {
  action: RepairAction;
  explanation: string;
  result: string;
}
export interface SetupAgentState {
  busy: boolean;
  phase:
    | 'idle'
    | 'diagnosing'
    | 'thinking'
    | 'working'
    | 'waiting_user'
    | 'ready'
    | 'error'
    | 'cancelled';
  message: string;
  diagnosis: SetupDiagnosis | null;
  history: RepairEntry[];
}
