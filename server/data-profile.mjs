// Existing deployments keep their configured transports until they select the local profile.
export function localData(env) {
  const profile = env.DATA_PROFILE || 'configured';
  if (!['local', 'configured'].includes(profile)) throw Error('DATA_PROFILE должен быть local или configured.');
  return profile === 'local';
}

export function checkModelTransport(env) {
  if (localData(env)) throw Error('Обработка локальная. Передача данных модели отключена.');
}

export function checkDestination(env, url) {
  if (!localData(env)) return;
  const target = new URL(url);
  const allowed = (env.LOCAL_HTTP_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!['http:', 'https:'].includes(target.protocol) || !allowed.includes(target.origin))
    throw Error('Адрес интеграции не разрешён локальным профилем: ' + target.origin);
}

export function integrationTransport(env, send) {
  return (url, init) => {
    if (!localData(env)) return send(url, init);
    checkDestination(env, url);
    return send(url, { ...init, redirect: 'error' });
  };
}

export function notificationChannels(env) {
  const supported = ['telegram', 'smtp'];
  if (env.NOTIFICATION_CHANNELS === undefined) return supported;
  const selected = env.NOTIFICATION_CHANNELS.split(',').map(channel => channel.trim());
  return supported.filter(channel => selected.includes(channel));
}

export function checkSmtp(env) {
  const local = localData(env);
  const host = env.SMTP_HOST || '';
  const port = env.SMTP_PORT || '587';
  if (local && host + ':' + port !== env.LOCAL_SMTP_TARGET)
    throw Error('SMTP-адрес не разрешён локальным профилем.');
  if (env.SMTP_TLS === 'plain' && (!local || !['127.0.0.1', '::1'].includes(host) || env.SMTP_USER || env.SMTP_PASSWORD))
    throw Error('SMTP_TLS=plain доступен только для локального приёмника на loopback без авторизации.');
}
