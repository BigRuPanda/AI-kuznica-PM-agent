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
