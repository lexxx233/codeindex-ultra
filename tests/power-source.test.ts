import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBackgroundIndexingPolicy,
  parseLinuxPowerSupplies,
  parseMacOsPowerSource,
  parseWindowsBatteryStatus,
  readLinuxPowerSource,
  readMacOsPowerSource,
  readWindowsPowerSource,
} from "../src/utils/power-source.js";

describe("macOS power source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses AC and battery power from pmset output", () => {
    expect(parseMacOsPowerSource("Now drawing from 'AC Power'\n")).toBe("ac");
    expect(parseMacOsPowerSource("Now drawing from 'Battery Power'\n")).toBe("battery");
    expect(parseMacOsPowerSource("No power source available\n")).toBe("unknown");
  });

  it("runs pmset with a five-second timeout", async () => {
    const runCommand = vi.fn().mockResolvedValue("Now drawing from 'Battery Power'\n");

    await expect(readMacOsPowerSource(runCommand)).resolves.toBe("battery");
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/bin/pmset",
      ["-g", "batt"],
      { timeoutMs: 5_000 },
    );
  });

  it("does not create a policy when disabled or on an unsupported platform", () => {
    const readPowerSource = vi.fn().mockResolvedValue("battery");

    expect(createBackgroundIndexingPolicy(false, {
      platform: "darwin",
      readPowerSource,
    })).toBeNull();
    expect(createBackgroundIndexingPolicy(true, {
      platform: "freebsd",
      readPowerSource,
    })).toBeNull();
    expect(readPowerSource).not.toHaveBeenCalled();
  });

  it("pauses on battery and resumes on AC power", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readPowerSource = vi.fn()
      .mockResolvedValueOnce("battery")
      .mockResolvedValueOnce("ac");
    const policy = createBackgroundIndexingPolicy(true, {
      platform: "darwin",
      readPowerSource,
      recheckDelayMs: 10,
    });

    await expect(policy?.isPaused()).resolves.toBe(true);
    await expect(policy?.isPaused()).resolves.toBe(false);

    expect(consoleWarn).toHaveBeenNthCalledWith(
      1,
      "[codebase-index] Background indexing paused while macOS is using battery power.",
    );
    expect(consoleWarn).toHaveBeenNthCalledWith(
      2,
      "[codebase-index] AC power detected; resuming pending background indexing.",
    );
  });

  it("logs once and allows indexing when power detection fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const readPowerSource = vi.fn().mockRejectedValue(new Error("pmset timed out"));
    const policy = createBackgroundIndexingPolicy(true, {
      platform: "darwin",
      readPowerSource,
    });

    await expect(policy?.isPaused()).resolves.toBe(false);
    await expect(policy?.isPaused()).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[codebase-index] Failed to determine the macOS power source; background indexing will continue: pmset timed out",
    );
  });

  it("fails open for unrecognized pmset output", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const policy = createBackgroundIndexingPolicy(true, {
      platform: "darwin",
      readPowerSource: vi.fn().mockResolvedValue("unknown"),
    });

    await expect(policy?.isPaused()).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("background indexing will continue"),
    );
  });
});

describe("linux power source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses battery supplies and reports battery only while discharging", () => {
    expect(parseLinuxPowerSupplies([])).toBe("ac");
    expect(parseLinuxPowerSupplies([{ type: "Mains", status: "online" }])).toBe("ac");
    expect(parseLinuxPowerSupplies([{ type: "Battery", status: "Discharging" }])).toBe("battery");
    expect(parseLinuxPowerSupplies([{ type: "Battery", status: "Charging" }])).toBe("ac");
    expect(parseLinuxPowerSupplies([{ type: "Battery", status: "Full" }])).toBe("ac");
    expect(parseLinuxPowerSupplies([{ type: "Battery" }])).toBe("ac");
  });

  it("reports battery while discharging", async () => {
    const supplyReader = vi.fn().mockResolvedValue([{ type: "Battery", status: "Discharging\n" }]);

    await expect(readLinuxPowerSource(supplyReader)).resolves.toBe("battery");
    expect(supplyReader).toHaveBeenCalledOnce();
  });

  it("reports AC while charging", async () => {
    const supplyReader = vi.fn().mockResolvedValue([
      { type: "Mains", status: "online" },
      { type: "Battery", status: "Charging" },
    ]);

    await expect(readLinuxPowerSource(supplyReader)).resolves.toBe("ac");
  });

  it("reports AC when no battery supply exists", async () => {
    const supplyReader = vi.fn().mockResolvedValue([{ type: "Mains", status: "online" }]);

    await expect(readLinuxPowerSource(supplyReader)).resolves.toBe("ac");
  });

  it("pauses on battery and labels warnings for the platform", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const policy = createBackgroundIndexingPolicy(true, {
      platform: "linux",
      readPowerSource: vi.fn().mockResolvedValue("battery"),
      recheckDelayMs: 10,
    });

    await expect(policy?.isPaused()).resolves.toBe(true);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[codebase-index] Background indexing paused while Linux is using battery power.",
    );
  });

  it("logs once and allows indexing when sysfs detection fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const policy = createBackgroundIndexingPolicy(true, {
      platform: "linux",
      readPowerSource: vi.fn().mockRejectedValue(new Error("sysfs unreadable")),
    });

    await expect(policy?.isPaused()).resolves.toBe(false);
    await expect(policy?.isPaused()).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[codebase-index] Failed to determine the Linux power source; background indexing will continue: sysfs unreadable",
    );
  });
});

describe("windows power source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses Win32_Battery status output", () => {
    expect(parseWindowsBatteryStatus("1\n")).toBe("battery");
    expect(parseWindowsBatteryStatus("2\r\n")).toBe("ac");
    expect(parseWindowsBatteryStatus("6")).toBe("ac");
    expect(parseWindowsBatteryStatus("")).toBe("ac");
    expect(parseWindowsBatteryStatus("unexpected error")).toBe("unknown");
  });

  it("reports battery for BatteryStatus 1", async () => {
    const runCommand = vi.fn().mockResolvedValue("1\n");

    await expect(readWindowsPowerSource(runCommand)).resolves.toBe("battery");
    expect(runCommand).toHaveBeenCalledWith(
      "powershell",
      ["-NoProfile", "-Command", "(Get-CimInstance Win32_Battery).BatteryStatus"],
      { timeoutMs: 5_000 },
    );
  });

  it("reports AC for BatteryStatus 2", async () => {
    const runCommand = vi.fn().mockResolvedValue("2\n");

    await expect(readWindowsPowerSource(runCommand)).resolves.toBe("ac");
  });

  it("logs once and allows indexing when the powershell query fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const policy = createBackgroundIndexingPolicy(true, {
      platform: "win32",
      readPowerSource: vi.fn().mockRejectedValue(new Error("powershell timed out")),
    });

    await expect(policy?.isPaused()).resolves.toBe(false);
    await expect(policy?.isPaused()).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[codebase-index] Failed to determine the Windows power source; background indexing will continue: powershell timed out",
    );
  });
});
