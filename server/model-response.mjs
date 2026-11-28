const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function invalidResponse(message, finishReason = null) {
  return Object.assign(Error(message), { invalidModelResponse: true, modelCode: 'invalid_response', finishReason });
}

function validArguments(value) {
  if (typeof value !== 'string') return false;
  try {
    return record(JSON.parse(value));
  } catch {
    return false;
  }
}

export function normalizeModelReply(message, { finishReason = null, usage, googleParts } = {}) {
  if (!record(message)) throw invalidResponse('Модель вернула пустой ответ.', finishReason);
  const { content, tool_calls: calls, refusal } = message;
  if (content != null && typeof content !== 'string') {
    throw invalidResponse('Модель вернула текст в неизвестном формате.', finishReason);
  }
  if (calls != null && (!Array.isArray(calls) ||
      calls.some(call => typeof call?.id !== 'string' || !call.id.trim() ||
        (call.type != null && call.type !== 'function') ||
        typeof call.function?.name !== 'string' || !call.function.name.trim() ||
        !validArguments(call.function.arguments)) ||
      new Set(calls.map(call => call.id)).size !== calls.length)) {
    throw invalidResponse('Модель вернула некорректный вызов инструмента.', finishReason);
  }
  const reason = typeof refusal === 'string' && refusal.trim() ? 'refusal' : finishReason;
  if (!content?.trim() && !calls?.length && !['length', 'refusal', 'content_filter'].includes(reason)) {
    throw invalidResponse('Модель вернула пустой ответ.', reason);
  }
  return {
    ...message, finishReason: reason, lengthLimited: reason === 'length', usage,
    ...(googleParts !== undefined && { googleParts }),
  };
}

export function modelAbortFailure(error, signal, parentSignal) {
  if (parentSignal?.aborted && signal.reason === parentSignal.reason) {
    return Object.assign(Error('Запрос к модели отменён.'), { modelCode: 'cancelled' });
  }
  if (signal.aborted || error?.name === 'TimeoutError') {
    return Object.assign(Error('Модель не успела ответить вовремя.'), { timedOut: true });
  }
  return null;
}

// Headers can arrive before a timeout or disconnect while consuming the body.
export async function readModelResponse(response, signal, parentSignal) {
  let data;
  try {
    data = await response.json();
  } catch (error) {
    const abort = modelAbortFailure(error, signal, parentSignal);
    if (abort) throw abort;
    if (error instanceof SyntaxError) throw invalidResponse('Модель вернула некорректный JSON.');
    throw Object.assign(Error('Соединение с провайдером прервалось при получении ответа.'),
      { retryable: true, modelCode: 'body_interrupted' });
  }
  const abort = modelAbortFailure(null, signal, parentSignal);
  if (abort) throw abort;
  return data;
}

export async function modelHttpFailure(response, signal, parentSignal, message) {
  const { status } = response;
  const receivedAt = Date.now();
  const header = response.headers?.get('Retry-After')?.trim() || '';
  const retryAt = /^\d+$/.test(header) ? receivedAt + Number(header) * 1000 : Date.parse(header);
  const metadata = { status };
  if (Number.isSafeInteger(retryAt) && retryAt > receivedAt) metadata.retryAt = retryAt;
  if (status === 429) metadata.modelCode = 'rate_limit';
  else if (status === 402) metadata.modelCode = 'quota';
  else if (status === 400) {
    const detail = await readModelResponse(response, signal, parentSignal).catch(error => {
      if (error.timedOut || error.modelCode === 'cancelled') throw error;
      return null;
    });
    if (detail?.error?.code === 'context_length_exceeded') metadata.modelCode = 'context_limit';
  }
  return Object.assign(Error(message), metadata);
}

export function completeModelText(reply) {
  if (reply.lengthLimited || ['length','refusal','content_filter'].includes(reply.finishReason)) return '';
  return typeof reply.content === 'string' ? reply.content.trim() : '';
}
