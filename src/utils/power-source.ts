import * as childProcess from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

export type PowerSource = "ac" | "battery" | "unknown";
export type MacOsPowerSource = PowerSource;

export interface BackgroundIndexingPolicy {
  readonly recheckDelayMs: number;
  isPaused(): Promise<boolean>;
}

export interface LinuxPowerSupply {
  type: string;
  status?: string;
}

type PowerSourceReader = () => Promise<PowerSource>;
type LinuxPowerSupplyReader = () => Promise<LinuxPowerSupply[]>;
type CommandRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<string>;

interface BackgroundIndexingPolicyOptions {
  platform?: NodeJS.Platform;
  readPowerSource?: PowerSourceReader;
  recheckDelayMs?: number;
}

const POWER_SOURCE_RECHECK_DELAY_MS = 60_000;
const PMSET_TIMEOUT_MS = 5_000;
const POWERSHELL_TIMEOUT_MS = 5_000;
const LINUX_POWER_SUPPLY_ROOT = "/sys/class/power_supply";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runCommand(
  file: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      file,
      args,
      { encoding: "utf8", timeout: options.timeoutMs },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function parseMacOsPowerSource(output: string): PowerSource {
  const match = output.match(/Now drawing from '([^']+)'/i);
  if (!match) {
    return "unknown";
  }

  const source = match[1].toLowerCase();
  if (source === "battery power") {
    return "battery";
  }
  if (source === "ac power") {
    return "ac";
  }
  return "unknown";
}

export async function readMacOsPowerSource(
  commandRunner: CommandRunner = runCommand,
): Promise<PowerSource> {
  const output = await commandRunner(
    "/usr/bin/pmset",
    ["-g", "batt"],
    { timeoutMs: PMSET_TIMEOUT_MS },
  );
  return parseMacOsPowerSource(output);
}

export function parseLinuxPowerSupplies(supplies: LinuxPowerSupply[]): PowerSource {
  const battery = supplies.find(
    (supply) => supply.type.trim().toLowerCase() === "battery",
  );
  if (!battery) {
    return "ac";
  }

  const status = battery.status?.trim().toLowerCase();
  return status === "discharging" ? "battery" : "ac";
}

export async function readLinuxPowerSupplies(): Promise<LinuxPowerSupply[]> {
  const entries = await fs.readdir(LINUX_POWER_SUPPLY_ROOT, { withFileTypes: true });
  return Promise.all(entries.map(async (entry) => {
    const supplyPath = path.join(LINUX_POWER_SUPPLY_ROOT, entry.name);
    const type = (await fs.readFile(path.join(supplyPath, "type"), "utf8")).trim();
    const status = await fs.readFile(path.join(supplyPath, "status"), "utf8")
      .then((output) => output.trim(), () => undefined);
    return { type, status };
  }));
}

export async function readLinuxPowerSource(
  supplyReader: LinuxPowerSupplyReader = readLinuxPowerSupplies,
): Promise<PowerSource> {
  return parseLinuxPowerSupplies(await supplyReader());
}

export function parseWindowsBatteryStatus(output: string): PowerSource {
  const match = output.match(/\d+/);
  if (!match) {
    // Empty output means no Win32_Battery instance (desktop on AC power).
    return output.trim().length === 0 ? "ac" : "unknown";
  }

  // Win32_Battery BatteryStatus 1 = discharging; 2+ means AC power is connected.
  return Number.parseInt(match[0], 10) === 1 ? "battery" : "ac";
}

export async function readWindowsPowerSource(
  commandRunner: CommandRunner = runCommand,
): Promise<PowerSource> {
  const output = await commandRunner(
    "powershell",
    ["-NoProfile", "-Command", "(Get-CimInstance Win32_Battery).BatteryStatus"],
    { timeoutMs: POWERSHELL_TIMEOUT_MS },
  );
  return parseWindowsBatteryStatus(output);
}

class BatteryBackgroundIndexingPolicy implements BackgroundIndexingPolicy {
  private lastPaused: boolean | null = null;
  private reportedFailure = false;

  constructor(
    private readonly readPowerSource: PowerSourceReader,
    private readonly platformLabel: string,
    readonly recheckDelayMs: number,
  ) {}

  isPaused(): Promise<boolean> {
    return this.checkPowerSource();
  }

  private async checkPowerSource(): Promise<boolean> {
    try {
      const source = await this.readPowerSource();
      if (source === "unknown") {
        throw new Error(`The ${this.platformLabel} power source was unrecognized`);
      }

      this.reportedFailure = false;
      const paused = source === "battery";
      if (paused && this.lastPaused !== true) {
        console.warn(`[codebase-index] Background indexing paused while ${this.platformLabel} is using battery power.`);
      } else if (!paused && this.lastPaused === true) {
        console.warn("[codebase-index] AC power detected; resuming pending background indexing.");
      }
      this.lastPaused = paused;
      return paused;
    } catch (error) {
      if (!this.reportedFailure) {
        console.error(
          `[codebase-index] Failed to determine the ${this.platformLabel} power source; background indexing will continue: ${getErrorMessage(error)}`,
        );
        this.reportedFailure = true;
      }
      this.lastPaused = false;
      return false;
    }
  }
}

export function createBackgroundIndexingPolicy(
  pauseOnBattery: boolean,
  options: BackgroundIndexingPolicyOptions = {},
): BackgroundIndexingPolicy | null {
  if (!pauseOnBattery) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  const recheckDelayMs = options.recheckDelayMs ?? POWER_SOURCE_RECHECK_DELAY_MS;
  switch (platform) {
    case "darwin":
      return new BatteryBackgroundIndexingPolicy(
        options.readPowerSource ?? readMacOsPowerSource,
        "macOS",
        recheckDelayMs,
      );
    case "linux":
      return new BatteryBackgroundIndexingPolicy(
        options.readPowerSource ?? readLinuxPowerSource,
        "Linux",
        recheckDelayMs,
      );
    case "win32":
      return new BatteryBackgroundIndexingPolicy(
        options.readPowerSource ?? readWindowsPowerSource,
        "Windows",
        recheckDelayMs,
      );
    default:
      return null;
  }
}
