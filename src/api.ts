import { Channel, invoke } from '@tauri-apps/api/core';
import type { ConnectionRequest } from './connection';
import type { WorkspaceSnapshot } from './snapshot';
import type { Config, ShellProfile, SystemInfo } from './types';

export type PtyMessage = string | { exit: number | null };

export interface SpawnRequest {
  /** Null when connecting to a remote host. */
  shell: ShellProfile | null;
  connection?: ConnectionRequest;
  /** ssh.exe to use for SSH connections; '' = Windows OpenSSH. */
  sshPath?: string;
  cwd: string;
  command: string | null;
  env: Record<string, string>;
  shellIntegration: boolean;
  cols: number;
  rows: number;
}

/** A key the SSH agent offers; 1Password puts the item's name in `comment`. */
export interface AgentKey {
  kind: string;
  comment: string;
  publicKey: string;
}

/** `running` is false when no SSH agent (1Password, Windows ssh-agent) is serving the pipe. */
export interface AgentKeys {
  running: boolean;
  keys: AgentKey[];
}

export const api = {
  spawn(request: SpawnRequest, onMessage: (msg: PtyMessage) => void): Promise<number> {
    const output = new Channel<PtyMessage>();
    output.onmessage = onMessage;
    return invoke<number>('pty_spawn', { request, output });
  },
  write: (id: number, data: string) => invoke<void>('pty_write', { id, data }),
  writeBytes: (id: number, data: number[]) => invoke<void>('pty_write_bytes', { id, data }),
  resize: (id: number, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows }),
  kill: (id: number) => invoke<void>('pty_kill', { id }),
  killAll: () => invoke<void>('pty_kill_all'),
  hasChildren: (id: number) => invoke<boolean>('pty_has_children', { id }),
  listShells: () => invoke<ShellProfile[]>('list_shells'),
  sshAgentKeys: (sshPath: string) => invoke<AgentKeys>('ssh_agent_keys', { sshPath }),
  sshPublicKeyFile: (key: string) => invoke<string>('ssh_public_key_file', { key }),
  loadConfig: () => invoke<Partial<Config> | null>('config_load'),
  saveConfig: (config: Config) => invoke<void>('config_save', { config }),
  loadWorkspace: () => invoke<unknown>('workspace_load'),
  saveWorkspace: (workspace: WorkspaceSnapshot) => invoke<void>('workspace_save', { workspace }),
  clipboardRead: () => invoke<string>('clipboard_read'),
  clipboardWrite: (text: string) => invoke<void>('clipboard_write', { text }),
  dirExists: (path: string) => invoke<boolean>('dir_exists', { path }),
  systemInfo: () => invoke<SystemInfo>('system_info'),
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  openDir: (path: string) => invoke<void>('open_dir', { path }),
};
