import { describe, it, expect } from "vitest";
import { assertSafeUrl, isBlockedAddress } from "../src/lib/urlGuard.js";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, and link-local IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks loopback, link-local, and unique-local IPv6", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks unrecognized input (fail closed)", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(/scheme/i);
    await expect(assertSafeUrl("ftp://example.com")).rejects.toThrow(/scheme/i);
  });

  it("rejects embedded credentials", async () => {
    await expect(assertSafeUrl("https://user:pass@example.com")).rejects.toThrow(/credential/i);
  });

  it("rejects literal internal addresses", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/admin")).rejects.toThrow(/internal/i);
    await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /internal/i,
    );
    await expect(assertSafeUrl("http://[::1]/")).rejects.toThrow(/internal/i);
  });

  it("rejects malformed and overly long URLs", async () => {
    await expect(assertSafeUrl("not a url")).rejects.toThrow(/invalid url/i);
    await expect(assertSafeUrl("https://example.com/" + "a".repeat(3000))).rejects.toThrow(
      /too long/i,
    );
  });
});
