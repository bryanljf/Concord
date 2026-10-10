/**
 * Windows process lookups needed by process-loopback capture: the owner pid of a window handle and
 * the (pid, parent pid) list of named processes. Both go through PowerShell (`-EncodedCommand`, so
 * no quoting issues) which costs ~0.4 s per call; `tasklist` is the fallback for the process list
 * when PowerShell is unavailable (it cannot report parent pids).
 */
import { execFile } from 'node:child_process';

export interface ProcessInfo {
  pid: number;
  /** Parent pid, or null when the source cannot report it (`tasklist`). */
  ppid: number | null;
  name: string;
}

/** Runs an executable and resolves with its stdout. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;

export const COMMAND_TIMEOUT_MS = 15_000;
const PROCESS_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function runCommand(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

/** PowerShell arguments that run `script` without any command-line quoting. */
export function powerShellArgs(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ];
}

const UTF8_OUTPUT = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';

export function windowOwnerPidScript(hwnd: number): string {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new RangeError(`invalid HWND: ${hwnd}`);
  return [
    "$ErrorActionPreference = 'Stop'",
    UTF8_OUTPUT,
    `$signature = '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);'`,
    "$type = Add-Type -MemberDefinition $signature -Name 'User32Window' -Namespace 'Concord' -PassThru",
    '[uint32]$owner = 0',
    `[void]$type::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]$owner)`,
    'Write-Output $owner',
  ].join('\n');
}

export function processListScript(names: readonly string[]): string {
  if (names.length === 0) throw new RangeError('at least one process name is required');
  for (const name of names) {
    if (!PROCESS_NAME_PATTERN.test(name)) throw new RangeError(`invalid process name: ${name}`);
  }
  const filter = names.map((name) => `Name='${name}'`).join(' OR ');
  return [
    "$ErrorActionPreference = 'Stop'",
    UTF8_OUTPUT,
    `$filter = "${filter}"`,
    '$rows = @(Get-CimInstance -ClassName Win32_Process -Filter $filter | Select-Object ProcessId, ParentProcessId, Name)',
    "if ($rows.Count -eq 0) { Write-Output '[]' } else { Write-Output (ConvertTo-Json -InputObject $rows -Compress) }",
  ].join('\n');
}

function toPid(value: unknown): number | null {
  const pid = typeof value === 'string' ? Number(value) : value;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Parses the JSON printed by `processListScript`; tolerant of single objects and quoted output. */
export function parseProcessListJson(stdout: string): ProcessInfo[] {
  let text = stdout.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  if (text === '' || text === 'null') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: ProcessInfo[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const pid = toPid(record.ProcessId);
    const name = typeof record.Name === 'string' ? record.Name : null;
    if (pid === null || name === null) continue;
    result.push({ pid, ppid: toPid(record.ParentProcessId), name });
  }
  return result;
}

/** Splits one line of `tasklist /FO CSV` (every field double-quoted, `""` escapes a quote). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** Parses `tasklist /FO CSV /NH` output into (name, pid) rows; parent pids are unavailable. */
export function parseTasklistCsv(stdout: string): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('"')) continue;
    const [name, pidField] = parseCsvLine(line);
    const pid = toPid(pidField);
    if (!name || pid === null) continue;
    result.push({ pid, ppid: null, name });
  }
  return result;
}

/** Owner pid of a top-level window handle, or 0 when it cannot be resolved. */
export async function getWindowOwnerPid(
  hwnd: number,
  run: CommandRunner = runCommand,
): Promise<number> {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) return 0;
  try {
    const stdout = await run('powershell.exe', powerShellArgs(windowOwnerPidScript(hwnd)));
    return toPid(stdout.trim()) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Running processes whose image name is in `names` (case-insensitive). PowerShell/CIM gives parent
 * pids; when it fails, `tasklist` provides the pids alone.
 */
export async function listProcessesByName(
  names: readonly string[],
  run: CommandRunner = runCommand,
): Promise<ProcessInfo[]> {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const matches = (rows: ProcessInfo[]): ProcessInfo[] =>
    rows.filter((row) => wanted.has(row.name.toLowerCase()));
  try {
    const stdout = await run('powershell.exe', powerShellArgs(processListScript(names)));
    return matches(parseProcessListJson(stdout));
  } catch {
    const stdout = await run('tasklist', ['/FO', 'CSV', '/NH']);
    return matches(parseTasklistCsv(stdout));
  }
}
