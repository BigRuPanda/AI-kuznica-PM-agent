import { Agent } from 'undici';

export const MODEL_TIMEOUT_MS = 600_000;
export const modelTimeout = timeout => Math.max(1,Math.min(MODEL_TIMEOUT_MS,timeout ?? MODEL_TIMEOUT_MS));
// Node's default dispatcher can cut off a request before the model's deadline.
export const modelDispatcher = new Agent({headersTimeout:MODEL_TIMEOUT_MS,bodyTimeout:MODEL_TIMEOUT_MS});

// Headers may arrive before a timeout or disconnect while consuming the response body.
export async function readModelResponse(response, signal) {
  try {
    return await response.json();
  } catch (error) {
    if (signal.aborted || error?.name === 'TimeoutError') {
      throw Object.assign(Error('Модель не успела ответить вовремя.'), {timedOut:true});
    }
    if (error instanceof SyntaxError) {
      throw Object.assign(Error('Модель вернула некорректный JSON.'), {invalidModelResponse:true});
    }
    throw Object.assign(Error('Соединение с провайдером прервалось при получении ответа.'), {retryable:true});
  }
}
