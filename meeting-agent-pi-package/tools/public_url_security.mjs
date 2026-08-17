import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname } from "node:path";

export const DEFAULT_PUBLIC_URL_LIMITS = Object.freeze({
  maxRedirects: 5,
  maxPageBytes: 8 * 1024 * 1024,
  maxTranscriptBytes: 32 * 1024 * 1024,
  maxMediaBytes: 1024 * 1024 * 1024,
  maxDurationSec: 8 * 60 * 60,
  timeoutMs: 30_000,
});

const SENSITIVE_QUERY_KEY = /(?:^|[_-])(?:access[_-]?key|api[_-]?key|auth|authorization|credential|expires?|policy|signature|sig|security[_-]?token|session|token|x-amz-.+|x-oss-.+)(?:$|[_-])/i;
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

export function extractPublicUrls(text) {
  const matches = String(text ?? "").match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return [...new Set(matches.map((value) => value.replace(/[),.;!?，。；！？）》】]+$/u, "")))];
}

export function sanitizeUrlForArtifact(value) {
  try {
    const url = new URL(String(value ?? ""));
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function redactSensitiveUrlsInText(value) {
  let text = String(value ?? "");
  for (const url of extractPublicUrls(text)) text = text.replaceAll(url, sanitizeUrlForArtifact(url));
  return text;
}

export function classifyPublicUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return { platform: "invalid", kind: "invalid" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const path = url.pathname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    return { platform: "youtube", kind: "video_page" };
  }
  if (host === "xiaoyuzhoufm.com" || host.endsWith(".xiaoyuzhoufm.com")) {
    return { platform: "xiaoyuzhou", kind: path.includes("/episode/") ? "podcast_episode" : "podcast_page" };
  }
  if (/\.(?:rss|xml)$/i.test(path) || /(?:^|[?&])format=rss(?:&|$)/i.test(url.search)) {
    return { platform: "rss", kind: "podcast_feed" };
  }
  if (/\.(?:aac|amr|flac|m4a|mp3|ogg|opus|wav|wma|avi|flv|mkv|mov|mp4|mpeg|webm|wmv)$/i.test(path)) {
    return { platform: "direct", kind: "direct_media" };
  }
  return { platform: "web", kind: "web_page" };
}

function ipv4Number(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InCidr(address, base, prefix) {
  const value = ipv4Number(address);
  const start = ipv4Number(base);
  if (value === null || start === null) return false;
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (value & mask) === (start & mask);
}

export function isBlockedNetworkAddress(address) {
  const normalized = String(address ?? "").toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const version = isIP(normalized);
  if (version === 4) {
    return [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([base, prefix]) => ipv4InCidr(normalized, base, prefix));
  }
  if (version === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) return isBlockedNetworkAddress(normalized.slice(7));
    return normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89a-f]/.test(normalized) ||
      normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
  }
  return true;
}

function normalizedPublicUrl(value) {
  const url = new URL(String(value ?? ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("public_url_scheme_blocked");
  if (url.username || url.password) throw new Error("public_url_credentials_blocked");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error("public_url_private_host_blocked");
  }
  return url;
}

export async function validatePublicUrl(value, options = {}) {
  let url;
  try {
    url = normalizedPublicUrl(value);
  } catch (error) {
    return { status: "blocked", reason: error instanceof Error ? error.message : String(error), url: "[blocked]" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lookupFn = options.lookupFn ?? dnsLookup;
  let addresses;
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookupFn(host, { all: true, verbatim: true });
  } catch (error) {
    return {
      status: "blocked",
      reason: "public_url_dns_failed",
      url: sanitizeUrlForArtifact(url),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const normalizedAddresses = (Array.isArray(addresses) ? addresses : [addresses]).filter((item) => item?.address);
  if (normalizedAddresses.length === 0) return { status: "blocked", reason: "public_url_dns_empty", url: sanitizeUrlForArtifact(url) };
  if (normalizedAddresses.some((item) => isBlockedNetworkAddress(item.address))) {
    return { status: "blocked", reason: "public_url_private_address_blocked", url: sanitizeUrlForArtifact(url) };
  }
  return { status: "ready", url, addresses: normalizedAddresses };
}

export async function validatePublicRedirect(from, location, options = {}) {
  let target;
  try {
    target = new URL(String(location ?? ""), String(from));
  } catch {
    return { status: "blocked", reason: "public_url_redirect_invalid" };
  }
  const validated = await validatePublicUrl(target, options);
  if (validated.status !== "ready") return { ...validated, reason: `public_url_redirect_${validated.reason}` };
  return validated;
}

export function enforceContentLength(headers, maxBytes) {
  const raw = headers?.["content-length"] ?? headers?.get?.("content-length") ?? null;
  const size = Number(raw);
  if (Number.isFinite(size) && size > Number(maxBytes)) {
    return { status: "blocked", reason: "public_url_size_limit_exceeded", contentLength: size, maxBytes: Number(maxBytes) };
  }
  return { status: "ready", contentLength: Number.isFinite(size) ? size : null, maxBytes: Number(maxBytes) };
}

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    if (options?.all) return callback(null, addresses);
    const selected = addresses[0];
    return callback(null, selected.address, selected.family);
  };
}

async function openPublicResponse(value, options = {}, redirectCount = 0) {
  const maxRedirects = Number(options.maxRedirects ?? DEFAULT_PUBLIC_URL_LIMITS.maxRedirects);
  const validated = await validatePublicUrl(value, options);
  if (validated.status !== "ready") throw Object.assign(new Error(validated.reason), { diagnostic: validated });
  const url = validated.url instanceof URL ? validated.url : new URL(String(validated.url));
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
  const response = await new Promise((resolveRequest, rejectRequest) => {
    const req = requestImpl(url, {
      method: options.method ?? "GET",
      headers: {
        "user-agent": options.userAgent ?? "Assignment-Agent-Public-Source/1.0",
        accept: options.accept ?? "*/*",
        "accept-encoding": "identity",
        ...(options.rangeProbe ? { range: "bytes=0-0" } : {}),
      },
      lookup: pinnedLookup(validated.addresses),
    }, resolveRequest);
    req.setTimeout(Number(options.timeoutMs ?? DEFAULT_PUBLIC_URL_LIMITS.timeoutMs), () => req.destroy(new Error("public_url_request_timeout")));
    req.on("error", rejectRequest);
    req.end();
  });
  const statusCode = Number(response.statusCode ?? 0);
  if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
    response.resume();
    if (redirectCount >= maxRedirects) throw new Error("public_url_redirect_limit_exceeded");
    const redirect = await validatePublicRedirect(url, response.headers.location, options);
    if (redirect.status !== "ready") throw Object.assign(new Error(redirect.reason), { diagnostic: redirect });
    if (!("url" in redirect) || !(redirect.url instanceof URL)) throw new Error("public_url_redirect_target_invalid");
    return openPublicResponse(redirect.url, options, redirectCount + 1);
  }
  return { response, finalUrl: url, redirectCount, statusCode };
}

export async function probePublicResource(value, options = {}) {
  let opened;
  try {
    opened = await openPublicResponse(value, { ...options, method: "HEAD" });
  } catch (error) {
    return { status: "blocked", reason: error instanceof Error ? error.message : String(error), diagnostic: error?.diagnostic ?? null };
  }
  let { response, finalUrl, redirectCount, statusCode } = opened;
  if ([405, 501].includes(statusCode)) {
    response.destroy();
    try {
      opened = await openPublicResponse(value, { ...options, method: "GET", rangeProbe: true });
      ({ response, finalUrl, redirectCount, statusCode } = opened);
    } catch (error) {
      return { status: "blocked", reason: error instanceof Error ? error.message : String(error), diagnostic: error?.diagnostic ?? null };
    }
  }
  response.destroy();
  if (statusCode < 200 || statusCode >= 400) {
    return { status: "blocked", reason: "public_url_http_error", httpStatus: statusCode, finalUrl: sanitizeUrlForArtifact(finalUrl) };
  }
  const contentRange = String(response.headers["content-range"] ?? "");
  const rangeTotal = Number(contentRange.match(/\/(\d+)$/)?.[1]);
  const sizeHeaders = Number.isFinite(rangeTotal) ? { ...response.headers, "content-length": String(rangeTotal) } : response.headers;
  const size = enforceContentLength(sizeHeaders, Number(options.maxBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes));
  if (size.status !== "ready") return { ...size, finalUrl: sanitizeUrlForArtifact(finalUrl) };
  return {
    status: "ready",
    finalUrl: sanitizeUrlForArtifact(finalUrl),
    contentType: String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(),
    contentLength: size.contentLength,
    redirectCount,
  };
}

export async function fetchPublicResource(value, options = {}) {
  const maxBytes = Number(options.maxBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxPageBytes);
  let opened;
  try {
    opened = await openPublicResponse(value, { ...options, method: "GET" });
  } catch (error) {
    return { status: "blocked", reason: error instanceof Error ? error.message : String(error), diagnostic: error?.diagnostic ?? null };
  }
  const { response, finalUrl, redirectCount, statusCode } = opened;
  if (statusCode < 200 || statusCode >= 300) {
    response.resume();
    return { status: "blocked", reason: "public_url_http_error", httpStatus: statusCode, finalUrl: sanitizeUrlForArtifact(finalUrl) };
  }
  const size = enforceContentLength(response.headers, maxBytes);
  if (size.status !== "ready") {
    response.destroy();
    return { ...size, finalUrl: sanitizeUrlForArtifact(finalUrl) };
  }
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        response.destroy();
        return { status: "blocked", reason: "public_url_size_limit_exceeded", maxBytes, bytesRead: bytes, finalUrl: sanitizeUrlForArtifact(finalUrl) };
      }
      chunks.push(chunk);
    }
  } catch (error) {
    return { status: "blocked", reason: "public_url_read_failed", error: error instanceof Error ? error.message : String(error), finalUrl: sanitizeUrlForArtifact(finalUrl) };
  }
  return {
    status: "completed",
    finalUrl: sanitizeUrlForArtifact(finalUrl),
    contentType: String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(),
    contentLength: bytes,
    body: Buffer.concat(chunks),
    redirectCount,
  };
}

export async function downloadPublicResource(value, destination, options = {}) {
  const maxBytes = Number(options.maxBytes ?? DEFAULT_PUBLIC_URL_LIMITS.maxMediaBytes);
  let opened;
  try {
    opened = await openPublicResponse(value, { ...options, method: "GET" });
  } catch (error) {
    return { status: "blocked", reason: error instanceof Error ? error.message : String(error), diagnostic: error?.diagnostic ?? null };
  }
  const { response, finalUrl, redirectCount, statusCode } = opened;
  if (statusCode < 200 || statusCode >= 300) {
    response.resume();
    return { status: "blocked", reason: "public_url_http_error", httpStatus: statusCode, finalUrl: sanitizeUrlForArtifact(finalUrl) };
  }
  const size = enforceContentLength(response.headers, maxBytes);
  if (size.status !== "ready") {
    response.destroy();
    return { ...size, finalUrl: sanitizeUrlForArtifact(finalUrl) };
  }
  mkdirSync(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    await new Promise((resolveWrite, rejectWrite) => {
      const output = createWriteStream(partial, { flags: "w", mode: 0o600 });
      const fail = (error) => {
        response.destroy();
        output.destroy();
        rejectWrite(error);
      };
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) return fail(new Error("public_url_size_limit_exceeded"));
        hash.update(chunk);
      });
      response.on("error", fail);
      output.on("error", fail);
      output.on("finish", () => resolveWrite());
      response.pipe(output);
    });
    renameSync(partial, destination);
  } catch (error) {
    try { unlinkSync(partial); } catch {}
    return {
      status: "blocked",
      reason: error instanceof Error ? error.message : "public_url_download_failed",
      maxBytes,
      bytesRead: bytes,
      finalUrl: sanitizeUrlForArtifact(finalUrl),
    };
  }
  return {
    status: "completed",
    path: destination,
    sizeBytes: bytes,
    sha256: hash.digest("hex"),
    finalUrl: sanitizeUrlForArtifact(finalUrl),
    contentType: String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(),
    redirectCount,
  };
}
