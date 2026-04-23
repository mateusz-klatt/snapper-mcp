import { describe, it, expect } from "vitest";

import { EnvValidationError, computeRefreshUrl, parseEnv } from "../src/env.js";

function baseEnv(overrides: Partial<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  return {
    SNAPPER_BASE_URL: "http://localhost:8000/api/mcp",
    SNAPPER_ACCESS_TOKEN: "access-jwt",
    SNAPPER_REFRESH_TOKEN: "refresh-jwt",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("parseEnv", () => {
  it("returns a validated BridgeEnv on the happy path with a trailing slash appended to the base URL path", () => {
    const result = parseEnv(baseEnv());
    expect(result.baseUrl).toBeInstanceOf(URL);
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBe("refresh-jwt");
  });

  it("leaves the URL unchanged when the user already provided a trailing slash", () => {
    const result = parseEnv(baseEnv({ SNAPPER_BASE_URL: "http://localhost:8000/api/mcp/" }));
    expect(result.baseUrl.toString()).toBe("http://localhost:8000/api/mcp/");
  });

  it("trims surrounding whitespace on tokens but keeps the canonical URL", () => {
    const result = parseEnv(
      baseEnv({ SNAPPER_ACCESS_TOKEN: "  access-jwt  ", SNAPPER_REFRESH_TOKEN: "\trefresh-jwt\n" }),
    );
    expect(result.accessToken).toBe("access-jwt");
    expect(result.refreshToken).toBe("refresh-jwt");
  });

  it("throws EnvValidationError with the missing variable name when SNAPPER_BASE_URL is absent", () => {
    expect(() => parseEnv(baseEnv({ SNAPPER_BASE_URL: undefined }))).toThrow(EnvValidationError);
    try {
      parseEnv(baseEnv({ SNAPPER_BASE_URL: undefined }));
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
        expect(error.message).toContain("SNAPPER_BASE_URL");
      }
    }
  });

  it("throws with the exact variable name when SNAPPER_ACCESS_TOKEN is absent", () => {
    try {
      parseEnv(baseEnv({ SNAPPER_ACCESS_TOKEN: undefined }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
      }
    }
  });

  it("throws when SNAPPER_REFRESH_TOKEN is absent", () => {
    try {
      parseEnv(baseEnv({ SNAPPER_REFRESH_TOKEN: undefined }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_REFRESH_TOKEN");
      }
    }
  });

  it("rejects blank (whitespace-only) tokens", () => {
    try {
      parseEnv(baseEnv({ SNAPPER_ACCESS_TOKEN: "   " }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_ACCESS_TOKEN");
        expect(error.message).toMatch(/empty/i);
      }
    }
  });

  it("rejects an unparseable SNAPPER_BASE_URL", () => {
    try {
      parseEnv(baseEnv({ SNAPPER_BASE_URL: "not-a-url" }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      if (error instanceof EnvValidationError) {
        expect(error.variable).toBe("SNAPPER_BASE_URL");
        expect(error.message).toMatch(/not a valid URL/);
      }
    }
  });
});

describe("computeRefreshUrl", () => {
  it("derives ${origin}/api/auth/refresh?return_tokens=true from an /api/mcp base", () => {
    const refresh = computeRefreshUrl(new URL("http://localhost:8000/api/mcp"));
    expect(refresh.pathname).toBe("/api/auth/refresh");
    expect(refresh.origin).toBe("http://localhost:8000");
    expect(refresh.searchParams.get("return_tokens")).toBe("true");
    expect(refresh.toString()).toBe("http://localhost:8000/api/auth/refresh?return_tokens=true");
  });

  it("does NOT concatenate the refresh path onto the /api/mcp segment", () => {
    const refresh = computeRefreshUrl(new URL("https://snapper.example.com/api/mcp"));
    expect(refresh.pathname).toBe("/api/auth/refresh");
    expect(refresh.pathname.startsWith("/api/mcp")).toBe(false);
  });

  it("preserves https scheme + host + port", () => {
    const refresh = computeRefreshUrl(new URL("https://snapper.example.com:8443/api/mcp"));
    expect(refresh.origin).toBe("https://snapper.example.com:8443");
    expect(refresh.toString()).toBe(
      "https://snapper.example.com:8443/api/auth/refresh?return_tokens=true",
    );
  });

  it("always sets return_tokens=true — backend returns null tokens without it", () => {
    const refresh = computeRefreshUrl(new URL("http://localhost:8000/api/mcp"));
    expect(refresh.search).toContain("return_tokens=true");
  });
});
