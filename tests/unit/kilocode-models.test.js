import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  resolveKilocodeModels,
  clearKilocodeCatalogCache,
  KILOCODE_GATEWAY_MODELS_URL,
} from "../../open-sse/services/kilocodeModels.js";

const catalog = {
  data: [
    { id: "cohere/north-mini-code:free", name: "North Mini Code" },
    { id: "poolside/laguna-m.1:free", name: "Laguna" },
    { id: "openai/gpt-4.1", name: "GPT-4.1" },
    { id: "openai/text-embedding-3-large", name: "Embed" },
    { id: "openai/gpt-4o-mini-tts", name: "TTS" },
    { id: "black-forest-labs/FLUX.1-schnell", name: "Flux" },
    { id: "", name: "nameless" },
    { name: "no id at all" },
  ],
};

function mockFetchOnce(payload, { ok = true } = {}) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => payload }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  clearKilocodeCatalogCache();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveKilocodeModels", () => {
  it("maps the gateway catalog to chat models, skipping media kinds and id-less entries", async () => {
    mockFetchOnce(catalog);
    const result = await resolveKilocodeModels();
    expect(result.models.map((m) => m.id).sort()).toEqual([
      "cohere/north-mini-code:free",
      "openai/gpt-4.1",
      "poolside/laguna-m.1:free",
    ]);
  });

  it("hits the kilo gateway models endpoint", async () => {
    const fetchMock = mockFetchOnce(catalog);
    await resolveKilocodeModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(KILOCODE_GATEWAY_MODELS_URL);
  });

  it("returns null when the catalog fetch fails (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await resolveKilocodeModels()).toBeNull();
  });

  it("returns null on a non-ok response (fail-open)", async () => {
    mockFetchOnce({}, { ok: false });
    expect(await resolveKilocodeModels()).toBeNull();
  });

  it("serves the second call from cache without refetching", async () => {
    const fetchMock = mockFetchOnce(catalog);
    const first = await resolveKilocodeModels();
    const second = await resolveKilocodeModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("serves stale cache immediately while refreshing in the background", async () => {
    const fetchMock = mockFetchOnce(catalog);
    const first = await resolveKilocodeModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const stale = await resolveKilocodeModels();
    expect(stale).toEqual(first);
    // Background refresh kicked off without blocking the caller.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    vi.useRealTimers();
  });
});
