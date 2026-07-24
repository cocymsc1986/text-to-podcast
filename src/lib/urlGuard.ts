// Guard against Server-Side Request Forgery (SSRF). This service fetches
// whatever URL a caller hands it, so without a guard someone could point it at
// internal services or the cloud metadata endpoint (169.254.169.254) and have
// the Lambda fetch secrets on their behalf. We only allow http/https to public
// addresses, and we re-validate every redirect hop (see extract.ts).
import dns from "node:dns/promises";
import net from "node:net";
import { MAX_URL_LENGTH } from "./limits.js";

/**
 * Validate a URL is safe to fetch: http/https, no embedded credentials, and
 * resolving only to public IP addresses. Throws with a clear message otherwise.
 * Returns the parsed URL so callers can reuse it.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  if (!raw || raw.length > MAX_URL_LENGTH) {
    throw new Error(`URL is missing or too long (max ${MAX_URL_LENGTH} chars)`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme "${url.protocol}" (only http and https allowed)`);
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  // Resolve the host to its real IPs and reject anything internal. If the host
  // is already a literal IP, check it directly.
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new Error(`Could not resolve host: ${host}`);
    }
  }
  if (addresses.length === 0) throw new Error(`Could not resolve host: ${host}`);
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new Error(`Refusing to fetch a private/internal address (${host} -> ${addr})`);
    }
  }
  return url;
}

/** True if an IP literal is loopback, private, link-local, or otherwise reserved. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true; // unrecognized -> block, fail closed
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  const norm = ip.toLowerCase().split("%")[0]; // drop any zone id
  if (norm === "::" || norm === "::1") return true; // unspecified / loopback
  if (norm.startsWith("fe80")) return true; // link-local
  if (norm.startsWith("fc") || norm.startsWith("fd")) return true; // unique local (fc00::/7)
  if (norm.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 address.
  const mapped = norm.match(/(?:::ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedV4(mapped[1]);
  return false;
}
