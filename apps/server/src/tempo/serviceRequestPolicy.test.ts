import { describe, expect, it } from "vite-plus/test";

import {
  decodeServiceBody,
  makeSecretRedactor,
  normalizeServiceBaseUrl,
  normalizeServicePathPrefix,
  pathAllowedByPrefixes,
  REDACTED,
  resolveServiceUrl,
  safeResponseHeaders,
} from "./serviceRequestPolicy.ts";

const resolvedPath = (baseUrl: string, path: string) => {
  const resolution = resolveServiceUrl(baseUrl, path);
  return resolution._tag === "Resolved" ? resolution.url.toString() : resolution._tag;
};

describe("service base URLs", () => {
  it("accepts https and loopback http, and nothing that would move a request elsewhere", () => {
    expect(normalizeServiceBaseUrl("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(normalizeServiceBaseUrl("http://localhost:8787/api")).toBe("http://localhost:8787/api");
    expect(normalizeServiceBaseUrl("http://api.example.com")).toBeNull();
    expect(normalizeServiceBaseUrl("https://user:pass@api.example.com")).toBeNull();
    expect(normalizeServiceBaseUrl("https://api.example.com/v1?token=1")).toBeNull();
    expect(normalizeServiceBaseUrl("https://api.example.com/v1#x")).toBeNull();
    expect(normalizeServiceBaseUrl("ftp://api.example.com")).toBeNull();
  });

  it("drops a bare trailing ? or #, which would turn every path into a query or fragment", () => {
    const base = normalizeServiceBaseUrl("https://openrouter.ai/api/v1?");
    expect(base).toBe("https://openrouter.ai/api/v1");
    expect(normalizeServiceBaseUrl("https://openrouter.ai/api/v1/#")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(resolvedPath(base!, "/keys")).toBe("https://openrouter.ai/api/v1/keys");
  });
});

describe("request paths", () => {
  const base = "https://api.cloudflare.com/client/v4";

  it("joins paths below the base", () => {
    expect(resolvedPath(base, "/zones")).toBe("https://api.cloudflare.com/client/v4/zones");
    expect(resolvedPath(base, "zones/abc/dns_records")).toBe(
      "https://api.cloudflare.com/client/v4/zones/abc/dns_records",
    );
    expect(resolvedPath(base, "")).toBe("https://api.cloudflare.com/client/v4/");
  });

  it("refuses paths that leave the base host or path, however they are spelled", () => {
    expect(resolvedPath(base, "/../../v5/zones")).toBe("OutsideBase");
    expect(resolvedPath(base, "/zones/%2e%2e/%2E%2E/%2e%2e/other")).toBe("OutsideBase");
    expect(resolvedPath(base, "//evil.example.com/x")).toBe("InvalidPath");
    expect(resolvedPath(base, "/zones?name=x")).toBe("InvalidPath");
    expect(resolvedPath(base, "/zones#x")).toBe("InvalidPath");
    expect(resolvedPath(base, "/zones\\..\\..")).toBe("InvalidPath");
    expect(resolvedPath(base, "/zones\n")).toBe("https://api.cloudflare.com/client/v4/zones");
    expect(resolvedPath(base, "/zo\u0000nes")).toBe("InvalidPath");
  });

  it("refuses paths that climb once an upstream decodes encoded separators", () => {
    expect(resolvedPath(base, "/zones/..%2F..%2Faccounts")).toBe("InvalidPath");
    expect(resolvedPath(base, "/zones/%2e%2E%2faccounts")).toBe("InvalidPath");
    expect(resolvedPath(base, "/zones/%5c..%5caccounts")).toBe("InvalidPath");
    expect(resolvedPath(base, "/zones/%E0%A4%A")).toBe("InvalidPath");
    // An encoded slash inside one segment is an ordinary id.
    const project = resolveServiceUrl(base, "/projects/group%2Fapp");
    expect(project._tag === "Resolved" && project.decodedPath).toBe("/projects/group/app");
  });

  it("matches path prefixes by whole segments", () => {
    expect(pathAllowedByPrefixes("/keys", [])).toBe(true);
    expect(pathAllowedByPrefixes("/keys", ["/keys"])).toBe(true);
    expect(pathAllowedByPrefixes("/keys/abc", ["/keys"])).toBe(true);
    expect(pathAllowedByPrefixes("/keysmith", ["/keys"])).toBe(false);
    expect(pathAllowedByPrefixes("/credits", ["/keys", "/credits"])).toBe(true);
    expect(pathAllowedByPrefixes("/keys%2F..%2Fadmin", ["/keys"])).toBe(false);
  });

  it("saves prefixes as plain paths", () => {
    expect(normalizeServicePathPrefix("keys/")).toBe("/keys");
    expect(normalizeServicePathPrefix("/")).toBe("");
    expect(normalizeServicePathPrefix("/keys/../admin")).toBeNull();
    expect(normalizeServicePathPrefix("/keys?x=1")).toBeNull();
  });
});

describe("responses", () => {
  const secret = "sk-or-v1-secret/value+1";
  const redact = makeSecretRedactor([secret, "short"]);

  it("redacts secrets in text, URL-encoded, and JSON-escaped forms", () => {
    expect(redact(`key=${secret}`)).toBe(`key=${REDACTED}`);
    expect(redact(`key=${encodeURIComponent(secret)}`)).toBe(`key=${REDACTED}`);
    // Secrets shorter than six characters are left alone so ordinary text survives.
    expect(redact("a short note")).toBe("a short note");
    expect(makeSecretRedactor([secret], "[saved]")(`key=${secret}`)).toBe("key=[saved]");

    const escaped = JSON.stringify({ echoed: secret }).replace("/", "\\/");
    const decoded = decodeServiceBody({
      bytes: new TextEncoder().encode(escaped),
      truncated: false,
      contentType: "application/json",
      redact,
    });
    expect(decoded).toEqual({ body: { echoed: REDACTED }, bodyFormat: "json" });
  });

  it("returns cut JSON as text and does not show binary bodies", () => {
    expect(
      decodeServiceBody({
        bytes: new TextEncoder().encode('{"data": [1, 2'),
        truncated: true,
        contentType: "application/json",
        redact,
      }),
    ).toEqual({ body: '{"data": [1, 2', bodyFormat: "text" });
    expect(
      decodeServiceBody({
        bytes: new Uint8Array([0x89, 0x50]),
        truncated: false,
        contentType: "image/png",
        redact,
      }),
    ).toEqual({ body: null, bodyFormat: "binary" });
    expect(
      decodeServiceBody({ bytes: new Uint8Array(), truncated: false, contentType: "", redact }),
    ).toEqual({ body: null, bodyFormat: "empty" });
  });

  it("keeps only safe headers, with secrets redacted", () => {
    expect(
      safeResponseHeaders(
        {
          "content-type": "application/json",
          "x-ratelimit-remaining": "99",
          location: `https://openrouter.ai/next?key=${secret}`,
          "set-cookie": "session=abc",
          authorization: `Bearer ${secret}`,
          "x-api-key": secret,
        },
        redact,
      ),
    ).toEqual({
      "content-type": "application/json",
      "x-ratelimit-remaining": "99",
      location: `https://openrouter.ai/next?key=${REDACTED}`,
    });
  });
});
