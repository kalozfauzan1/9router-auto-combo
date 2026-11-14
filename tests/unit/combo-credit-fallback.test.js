import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("combo credit vs request-scoped fallback", () => {
  it.each([
    ["You have insufficient credits to make this request.", "credit"],
    ["Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", "credit"],
    ["Bad request", "request-scoped"],
  ])("advances after a 400 (%s), classified as %s", async (message, kind) => {
    // Credit failures allow account fallback; generic request rejection must not
    // cool a healthy account. Both still advance across combo providers.
    const classification = checkFallbackError(400, message, 0, "cmc");
    if (kind === "credit") {
      expect(classification.shouldFallback).toBe(true);
      expect(classification.requestScoped).not.toBe(true);
    } else {
      expect(classification).toEqual({
        shouldFallback: false, cooldownMs: 0, requestScoped: true,
      });
    }

    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const failure = Response.json({ error: { message } }, { status: 400 });
    const successBody = { choices: [{ message: { content: "served by second provider" } }] };
    const success = Response.json(successBody);
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success);

    const response = await handleComboChat({
      body, models, handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback", comboStrategy: "fallback",
    });

    expect(response).toBe(success);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(successBody);
    expect(handleSingleModel.mock.calls).toEqual(models.map((model) => [body, model]));
  });

  it("returns the first actual 400 intact when all providers reject the request", async () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const firstBody = '{"error":{"message":"Bad request","type":"invalid_request_error"},"request_id":"first"}';
    const first = new Response(firstBody, {
      status: 400, headers: { "content-type": "application/json", "x-request-id": "first" },
    });
    const second = Response.json({ error: { message: "Request validation failed" } }, { status: 400 });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const response = await handleComboChat({
      body, models, handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "request-rejection-fallback", comboStrategy: "fallback",
    });

    expect(handleSingleModel.mock.calls).toEqual(models.map((model) => [body, model]));
    expect(response).toBe(first);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("first");
    expect(await response.text()).toBe(firstBody);
  });
});
